# apü benchmarks (S4)

All numbers: Node 26.12.1, TLS + HTTP/2, JSON payloads, measured 2026-10-28. Reproduce with
`node bench/run.ts` (local, server and client in separate processes) and `bench/docker.sh`
(server in a CPU/RAM-limited container, client in a second container sharing its network
namespace; optional `tc netem` latency and bandwidth limit).

**Baselines** are hand-written `node:http2` endpoints without validation, framing or features: a
minimal JSON GET, NDJSON for streams (written without backpressure), and a plain JSON response
for bulk. They are a ceiling, not a competitor; the gap is the cost of apü's features (schema
validation and stripping, ETags, idempotency keys, framing, deadlines, cancellation).

## Key results

| | local (M-series, 10 cores) | Docker 1 CPU / 1 GiB | Docker 0.5 CPU / 256 MiB | Docker 1 CPU, WAN (63 ms RTT, 100 Mbit/s) |
|---|---|---|---|---|
| unary GET c=32: apü / raw | 25.4k / 47.7k req/s (53 %) | 14.0k / 26.5k (53 %) | 8.8k / 19.6k (45 %) | 383 / 397 req/s (96 %) |
| unary POST + Idempotency-Key c=32 | 19.9k req/s | 10.6k | 5.6k | 380 |
| stream, small msgs: apü / NDJSON | 1.94M / 2.82M msg/s (69 %) | 0.93M / 1.84M (51 %) | 0.34M / 0.91M (37 %) | 0.24M / 0.24M (98 %) |
| stream + zstd | 1.84M msg/s | 0.79M | 0.33M | **0.65M (2.7× NDJSON)** |
| 1 MiB responses: apü / raw | 320 / 409 MiB/s (78 %) | 170 / 195 (87 %) | 162 / 108 (noisy, CFS quota) | 6.3 / 6.5 |
| 1 MiB JSON with zstd (wire 118 KiB) | 160 MiB/s | 77 | 43 | **11.5 MiB/s (1.8× identity)** |
| 3 dependent calls: sequential / batch | 0.41 / 0.22 ms | 0.81 / 0.48 ms | 0.81 / 0.41 ms | **212 / 75 ms (2.8×)** |
| 4 MiB download: 64 KiB window / tuned | 111 / 320 MiB/s | 51 / 209 | 23 / 213 | **0.57 / 7.0 MiB/s (12×)** |
| server memory under load | — | 141 MiB | 93 MiB | 56 MiB |

## Conclusions

1. **On real networks the protocol design dominates, not CPU.** With 63 ms RTT the unary
   overhead disappears (96 % of raw), while pipelined batches (2.8×), compressed streams (2.7×) and
   tuned flow-control windows (12×) decide throughput and latency.
2. **The HTTP/2 window defaults are a real trap.** Node 26.12.1 still advertises the RFC's 64 KiB;
   apü sets 4 MiB per stream / 32 MiB per connection on both ends.
3. **Compression: zstd is the right default.** zstd-3 reaches about brotli-4's ratio (118 vs 101 KiB
   for 1 MiB) at ~1.5–1.7× its speed; gzip-1 is fast but only 3.2×. On loopback, compression costs
   throughput; behind 100 Mbit/s it is a net win from the first byte. Per-burst flushing keeps TTFB.
4. **CPU overhead on small machines is the remaining weak spot**: ~50 % of a raw handler for tiny
   unary calls and 37–69 % for message streams. The profile is now spread over node:http2 internals,
   JSON, validation and TLS; the large, cheap wins have been taken (see below).

## Optimizations driven by profiling (before → after, local)

Measured in two steps (each step's changes were benchmarked together end-to-end; the per-change
numbers are isolated micro-benchmarks):

| step | changes (isolated measurement) | end-to-end effect (local) |
|---|---|---|
| 1 | HTTP/2 core stream API instead of the compat layer (compat alone: −23 % req/s); no `AbortSignal.any` on the client (2.7 µs per call on Node 26); unary fast path without async generator; idempotency eviction O(n) → amortised O(1) (was 24 % of server CPU; Map tombstones kept a naïve fix at ~9 µs/insert, a FIFO queue brought it to 0.7 µs) | unary GET c=32 18.7k → 23.4k, c=1 5.3k → 7.6k; POST + key 7.4k → 18.7k req/s |
| 2 | single-allocation JSON frames via Buffer (frame encode 498 → 140 ns; Node's TextEncoder is ~4× slower than Buffer for short strings); schema validation without per-field allocations (2.1–2.3×, User 593 → 257 ns); one abort listener per stream instead of a `Promise.race` per item; batched frame decoding (async step per chunk, not per frame) | stream 0.91M → 1.94M msg/s |

Rejected after measuring: decoding whole chunks as Latin-1 with per-payload ASCII checks (only
14–17 % faster decode ≈ 3 % of client CPU, Node-only); larger per-stream buffers before waiting for
`drain` (no measurable effect).

## Caveats

- Docker Desktop runs containers in a VM on the same Mac; "1 CPU" is a CFS quota, which causes the
  tail latencies (p99 ~56 ms at 0.5 CPU) and the noisy bulk numbers at 0.5 CPU.
- netem applies to `lo` in the shared namespace, i.e. to both directions; the RTT was measured
  with ping (63 ms for 2 × 25 ms configured).
- Clients ran unconstrained; constrained-client numbers would be lower.

## Full results

#### local-mac-final

Node v26.12.1; 10 CPUs, 16384 MiB, server and client as separate processes on the same machine; 2026-10-28T02:10Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 13,347 req/s | 0.07 ms | 0.15 ms |
| unary c=1 | apü safe op (GET) | 9,455 req/s | 0.10 ms | 0.24 ms |
| unary c=1 | apü unsafe op (POST + key) | 8,828 req/s | 0.10 ms | 0.23 ms |
| unary c=32 | raw node:http2 GET | 47,724 req/s | 0.62 ms | 1.85 ms |
| unary c=32 | apü safe op (GET) | 25,371 req/s | 1.21 ms | 2.05 ms |
| unary c=32 | apü unsafe op (POST + key) | 19,940 req/s | 1.55 ms | 2.30 ms |
| server stream 200k small msgs | raw NDJSON (split + JSON.parse) | 2,820,182 msg/s |  |  |
| server stream 200k small msgs | apü stream (frames, validated) | 1,938,475 msg/s |  |  |
| server stream 200k small msgs | apü stream + zstd | 1,844,881 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 409 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 320 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.41 ms | 0.41 ms | 0.71 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.22 ms | 0.22 ms | 0.56 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 338 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 93.11 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 95.39 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 160 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 111 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 320 MiB/s |  |  |

#### docker-2cpu-1g

Node v26.12.1; server container: 2 CPU, 1g RAM; network: loopback → loopback; 2026-10-28T02:06Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 6,348 req/s | 0.15 ms | 0.33 ms |
| unary c=1 | apü safe op (GET) | 4,934 req/s | 0.19 ms | 0.40 ms |
| unary c=1 | apü unsafe op (POST + key) | 4,340 req/s | 0.22 ms | 0.49 ms |
| unary c=32 | raw node:http2 GET | 27,178 req/s | 1.09 ms | 3.13 ms |
| unary c=32 | apü safe op (GET) | 14,613 req/s | 2.07 ms | 3.86 ms |
| unary c=32 | apü unsafe op (POST + key) | 10,932 req/s | 2.81 ms | 5.20 ms |
| server stream 200k small msgs | raw NDJSON (split + JSON.parse) | 1,699,652 msg/s |  |  |
| server stream 200k small msgs | apü stream (frames, validated) | 1,165,749 msg/s |  |  |
| server stream 200k small msgs | apü stream + zstd | 944,178 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 183 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 132 MiB/s |  |  |
| 3 dependent calls | sequential calls | 1.04 ms | 1.04 ms | 2.27 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.69 ms | 0.69 ms | 1.21 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 163 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 50.68 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 47.14 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 77.57 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 85.24 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 147 MiB/s |  |  |

#### docker-1cpu-1g

Node v26.12.1; server container: 1 CPU, 1g RAM; network: loopback → loopback; 2026-10-28T02:06Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 6,508 req/s | 0.14 ms | 0.30 ms |
| unary c=1 | apü safe op (GET) | 5,039 req/s | 0.19 ms | 0.38 ms |
| unary c=1 | apü unsafe op (POST + key) | 4,248 req/s | 0.22 ms | 0.46 ms |
| unary c=32 | raw node:http2 GET | 26,480 req/s | 1.12 ms | 3.07 ms |
| unary c=32 | apü safe op (GET) | 13,994 req/s | 2.17 ms | 4.16 ms |
| unary c=32 | apü unsafe op (POST + key) | 10,649 req/s | 2.81 ms | 5.69 ms |
| server stream 200k small msgs | raw NDJSON (split + JSON.parse) | 1,836,266 msg/s |  |  |
| server stream 200k small msgs | apü stream (frames, validated) | 928,071 msg/s |  |  |
| server stream 200k small msgs | apü stream + zstd | 787,104 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 195 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 170 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.81 ms | 0.81 ms | 1.45 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.48 ms | 0.48 ms | 0.71 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 176 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 51.13 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 49.59 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 76.56 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 51.03 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 209 MiB/s |  |  |

#### docker-0.5cpu-256m

Node v26.12.1; server container: 0.5 CPU, 256m RAM; network: loopback → loopback; 2026-10-28T02:07Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 5,547 req/s | 0.15 ms | 0.37 ms |
| unary c=1 | apü safe op (GET) | 4,403 req/s | 0.19 ms | 0.47 ms |
| unary c=1 | apü unsafe op (POST + key) | 2,932 req/s | 0.23 ms | 0.75 ms |
| unary c=32 | raw node:http2 GET | 19,562 req/s | 1.14 ms | 19.43 ms |
| unary c=32 | apü safe op (GET) | 8,828 req/s | 2.20 ms | 56.23 ms |
| unary c=32 | apü unsafe op (POST + key) | 5,599 req/s | 3.22 ms | 57.16 ms |
| server stream 100k small msgs | raw NDJSON (split + JSON.parse) | 913,987 msg/s |  |  |
| server stream 100k small msgs | apü stream (frames, validated) | 336,037 msg/s |  |  |
| server stream 100k small msgs | apü stream + zstd | 326,985 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 108 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 162 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.81 ms | 0.81 ms | 1.83 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.41 ms | 0.41 ms | 0.76 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 175 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 41.57 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 30.10 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 42.54 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 22.89 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 213 MiB/s |  |  |

#### docker-1cpu-1g-wan

Node v26.12.1; server container: 1 CPU, 1g RAM; network: delay 25ms rate 100mbit → 62.568 ms RTT (measured); 2026-10-28T02:08Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 14.28 req/s | 69.95 ms | 94.61 ms |
| unary c=1 | apü safe op (GET) | 14.31 req/s | 70.57 ms | 81.14 ms |
| unary c=1 | apü unsafe op (POST + key) | 14.00 req/s | 72.61 ms | 84.53 ms |
| unary c=32 | raw node:http2 GET | 397 req/s | 81.04 ms | 91.37 ms |
| unary c=32 | apü safe op (GET) | 383 req/s | 84.64 ms | 96.94 ms |
| unary c=32 | apü unsafe op (POST + key) | 380 req/s | 85.04 ms | 96.97 ms |
| server stream 100k small msgs | raw NDJSON (split + JSON.parse) | 244,541 msg/s |  |  |
| server stream 100k small msgs | apü stream (frames, validated) | 238,567 msg/s |  |  |
| server stream 100k small msgs | apü stream + zstd | 652,700 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 6.49 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 6.34 MiB/s |  |  |
| 3 dependent calls | sequential calls | 212 ms | 212 ms | 234 ms |
| 3 dependent calls | apü batch (1 round trip) | 74.58 ms | 74.58 ms | 87.98 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 6.27 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 8.66 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 10.53 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 11.51 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 0.57 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 7.03 MiB/s |  |  |

