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

Final runs after all optimizations (spike S10). "c=32" = 32 concurrent calls on one HTTP/2 connection.
Re-run of the 1 CPU / 1 GiB profile after S16–S17 (review fixes, WebSocket flow control): unary GET
17.7k, POST + key 13.1k req/s, stream 0.93M (zstd 0.86M) msg/s, 1 MiB apü / raw 180 / 184 MiB/s,
tuned download 219 MiB/s, server memory 136 MiB — within run-to-run noise of the table (raw itself moved).

| | local (M-series, 10 cores) | Docker 2 CPU / 1 GiB | Docker 1 CPU / 1 GiB | Docker 0.5 CPU / 256 MiB | Docker 1 CPU, WAN (63 ms RTT, 100 Mbit/s) |
|---|---|---|---|---|---|
| unary GET c=32: apü / raw | 29.2k / 46.8k req/s (62 %) | 17.8k / 28.3k (63 %) | 17.9k / 28.2k (64 %) | 10.5k / 22.2k (47 %) | 385 / 407 req/s (95 %) |
| unary POST + Idempotency-Key c=32 | 20.9k req/s | 13.0k | 12.6k | 6.0k | 378 |
| stream, small msgs: apü / NDJSON | 1.96M / 2.61M msg/s (75 %) | 1.22M / 1.83M (67 %) | 0.94M / 1.94M (48 %) | 0.45M / 0.89M (50 %) | 0.24M / 0.24M (103 %) |
| stream + zstd | 1.69M msg/s | 0.96M | 0.85M | 0.32M | **0.64M (2.7× NDJSON)** |
| 1 MiB responses: apü / raw | 334 / 399 MiB/s (84 %) | 164 / 194 (85 %) | 195 / 215 (91 %) | 162 / 85 (artifact, see caveats) | 6.1 / 6.6 |
| 1 MiB JSON with zstd (wire 118 KiB) | 162 MiB/s | 77 | 76 | 51 | **11.3 MiB/s (1.8× identity)** |
| 3 dependent calls: sequential / batch | 0.67 / 0.31 ms | 0.75 / 0.39 ms | 0.75 / 0.39 ms | 0.91 / 0.48 ms | **203 / 67 ms (3.0×)** |
| 4 MiB download: 64 KiB window / tuned | 103 / 373 MiB/s | 88 / 209 | 68 / 210 | 23 / 146 | **0.56 / 2.9–7.0 MiB/s (5–12×)** |
| server memory under load | — | 143 MiB | 141 MiB | 94 MiB | 55 MiB |

## Against gRPC (`@grpc/grpc-js` 1.14.6, the official Node implementation)

Same machine, same shapes (`bench/grpc/bench.proto` mirrors `bench/api.ts`), TLS + HTTP/2 for both,
servers and client in separate processes (`node bench/run.ts --only grpc`). apü validates and
strips every output against its schema; gRPC (protobuf) does schema encoding instead.

| | gRPC (grpc-js) | apü | apü / gRPC |
|---|---|---|---|
| unary c=1 | 5,518 req/s (p50 0.17 ms) | 8,699 req/s (p50 0.11 ms) | 1.6× |
| unary c=32 | 19,697 req/s (p99 3.55 ms) | 29,634 req/s (p99 1.96 ms) | 1.5× |
| server stream, 200k small messages | 67,258 msg/s | 2,039,233 msg/s | 30× |

The stream gap is grpc-js' per-message cost, not the harness: with and without backpressure on the
server, and with `for await` or `'data'` events on the client, grpc-js stayed at 56–59k msg/s
(single-process check). apü's frame coalescing, batched decoding and single-allocation encoding
(below) make the difference. This says nothing about gRPC in Go, C++ or Rust.

## Multiplexing: small calls next to bulk transfers on one connection

`node bench/run.ts --only multiplex` (local): unary p50/p99 while 8 MiB downloads run concurrently
on the same HTTP/2 connection, for three client stream windows. Idle: 0.17 / 0.48 ms.

| stream window | during 8 MiB JSON downloads | during 8 MiB binary (BLOB) downloads | bulk throughput alongside (binary) |
|---|---|---|---|
| 4 MiB (default) | 2.44 / 14.65 ms | 2.47 / 6.65 ms | 761 MiB/s |
| 1 MiB | 0.80 / 12.32 ms | 1.28 / 3.03 ms | 708 MiB/s |
| 256 KiB | 0.36 / 11.48 ms | 0.21 / 1.46 ms | 899 MiB/s |

- **Window vs. latency**: everything a bulk stream may have in flight queues ahead of a small
  response in the shared TCP/TLS path (TCP head-of-line). A 256 KiB window keeps small calls at idle
  latency even next to 900 MiB/s of bulk — on loopback. On a WAN the window must be ≥ the
  bandwidth-delay product (63 ms × 100 Mbit/s ≈ 790 KB), or throughput collapses (12× in the WAN
  profile). The window should therefore track the BDP (gRPC-style BDP probing — planned), not be as
  large as possible; apü's 4 MiB default favours WAN throughput.
- **Large JSON blocks the event loop**: the p99 of 11–15 ms with JSON downloads doesn't depend on the
  window — it is `JSON.parse`/`stringify` of 8 MiB values on both sides. Large data belongs in
  `t.bytes()` (BLOB frames) or in streams of smaller messages.

### Window auto-tuning (gRPC's BDP estimator) — tried, not the default

`windowTuning: 'bdp'` in the node:http2 transport starts at 256 KiB and grows the window from PING
round trips (grow to 2× the sample when it fills > 2/3 of the window and the implied bandwidth is
a new maximum). Measured (2 × 16 MiB downloads; 40 ms RTT via an in-process latency proxy):

| | fixed 256 KiB | bdp auto | fixed 4 MiB |
|---|---|---|---|
| local throughput | 370 MiB/s | 536 MiB/s (window settles at 1 MiB) | 660 MiB/s |
| 40 ms RTT throughput | 2.8 MiB/s | 20.8 MiB/s (grows to 7.5 MiB) | 41.8 MiB/s |
| small-call p50 next to binary bulk (local) | 0.20 ms | 2.16 ms | 2.46 ms |
| small-call p50 next to JSON bulk (local) | 0.37 ms | 8.05 ms | 2.34 ms |

Without the bandwidth check the estimator was worse still (8–18 ms): PINGs queue behind data under
load, inflating sample and RTT together. Even with it, auto-tuning loses the ramp-up on WAN
transfers and doesn't keep small calls fast locally, so the default stays a fixed 4 MiB window;
latency-sensitive LAN deployments can choose a smaller fixed window.

## Conclusions

1. **On real networks the protocol design dominates, not CPU.** With 63 ms RTT the unary overhead
   disappears (95 % of a raw handler), while pipelined batches (3.0×), compressed streams (2.7×)
   and tuned flow-control windows (5–12×; the tuned result varied between runs) decide throughput
   and latency.
2. **The HTTP/2 window defaults are a real trap.** Node 26.12.1 still advertises the RFC's 64 KiB;
   apü sets 4 MiB per stream / 32 MiB per connection on both ends.
3. **Compression: zstd is the right default.** zstd-3 reaches about brotli-4's ratio (118 vs 101 KiB
   for 1 MiB) at ~1.5–1.7× its speed; gzip-1 is fast but only 3.2×. On loopback, compression costs
   throughput; behind 100 Mbit/s it is a net win. Per-burst flushing keeps TTFB.
4. **Against the established Node RPC stack apü is faster** (1.5× unary, 30× streaming vs grpc-js)
   while doing more per call (schema validation and stripping, ETags, idempotency).
5. **CPU overhead versus a hand-written handler is the remaining cost**: 47–64 % of a raw handler
   for tiny unary calls and 48–75 % for message streams (the raw baselines do no validation, no
   ETags, no idempotency and no backpressure). The profile is spread over node:http2 internals,
   JSON, validation and TLS; the large, cheap wins have been taken (see below).

## Optimizations driven by profiling (before → after, local)

Measured in three steps (each step's changes were benchmarked together end-to-end; the per-change
numbers are isolated micro-benchmarks or A/B runs):

| step | changes (isolated measurement) | end-to-end effect (local) |
|---|---|---|
| 1 | HTTP/2 core stream API instead of the compat layer (compat alone: −23 % req/s); no `AbortSignal.any` on the client (2.7 µs per call on Node 26); unary fast path without async generator; idempotency eviction O(n) → amortised O(1) (was 24 % of server CPU; Map tombstones kept a naïve fix at ~9 µs/insert, a FIFO queue brought it to 0.7 µs) | unary GET c=32 18.7k → 23.4k, c=1 5.3k → 7.6k; POST + key 7.4k → 18.7k req/s |
| 2 | single-allocation JSON frames via Buffer (frame encode 498 → 140 ns; Node's TextEncoder is ~4× slower than Buffer for short strings); schema validation without per-field allocations (2.1–2.3×, User 593 → 257 ns); one abort listener per stream instead of a `Promise.race` per item; batched frame decoding (async step per chunk, not per frame) | stream 0.91M → 1.94M msg/s |
| 3 | unread request bodies discarded only after `finish` (the early `resume()` made node:http2 destroy streams with a pending write and create an `ERR_STREAM_DESTROYED` per request); `respond()` without options; unary bodies read via events instead of an async iterator (A/B, 3 rounds: +4–6 %) | unary GET c=32 25.4k → 29.2k |
| 5 | WebSocket (T3) client streams: small frames coalesced into one send per 16 KiB or per macrotask (`MessageChannel`, not clamped like `setTimeout`; a lone message leaves in < 10 ms, tested) instead of one `ws.send` + WebSocket frame per message. First tried before the close fix below: WebKit then lost the last frames of a stream in 4 of 19 browser runs — the same failure later appeared without coalescing (1 of 31), a WebKit issue with server-initiated closes over RFC 8441, fixed by letting the client close after END (spec §8); with that fix 0 of 20 | 100k-message client stream 436k → 972k msg/s (HTTP/2: 905k); bulk unchanged (295 MiB/s) |
| 4 | WebSocket (T3) uploads: adaptive `bufferedAmount` polling instead of a fixed 5 ms (the fixed poll capped uploads at 1 MiB per 5 ms and left the socket idle ~25 % of the time: CPU/wall 0.83); server-side unmasking in 32-bit words (parser alone on 64 KiB frames in 16 KiB chunks: 0.75 → 3.3 GB/s); found while fixing quadratic frame buffering in the same parser (4 MiB frame in 1 KiB chunks: 791 → 16 ms) | 64 MiB upload as 1 MiB blobs over wss, client and server in one process: 142 → 293 MiB/s (pacing alone 227) |

Rejected after measuring: decoding whole chunks as Latin-1 with per-payload ASCII checks (only
14–17 % faster decode ≈ 3 % of client CPU, Node-only); larger per-stream buffers before waiting for
`drain` (no measurable effect); a schema-compiled "validate + serialize in one pass" built from
closures (no eval): 140 → 103 ns for a 3-field item but 421 → 448 ns for a nested user — V8's
native `JSON.stringify` after validation stays.

## Caveats

- Docker Desktop runs containers in a VM on the same Mac; "1 CPU" is a CFS quota, which causes the
  tail latencies (p99 50–66 ms at 0.5 CPU). At 0.5 CPU the raw bulk baseline came out *slower* than
  apü in two full runs. Running the bulk scenario alone twice gave raw/apü 174/154 and 128/141 MiB/s:
  at 0.5 CPU, bulk numbers swing ±20 % between runs, so that cell shows noise, not a difference.
- WAN runs vary: the tuned-window download was 7.0 MiB/s in one run and 2.9 MiB/s in the final
  one (TCP behaviour under netem); the 64 KiB window was 0.56–0.57 MiB/s in both.
- netem applies to `lo` in the shared namespace, i.e. to both directions; the RTT was measured
  with ping (63 ms for 2 × 25 ms configured).
- Clients ran unconstrained; constrained-client numbers would be lower.

## Full results

#### local-mac-final

Node v26.12.1; 10 CPUs, 16384 MiB, server and client as separate processes on the same machine; 2026-10-28T02:53Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 10,508 req/s | 0.09 ms | 0.18 ms |
| unary c=1 | apü safe op (GET) | 8,837 req/s | 0.11 ms | 0.20 ms |
| unary c=1 | apü unsafe op (POST + key) | 7,319 req/s | 0.13 ms | 0.26 ms |
| unary c=32 | raw node:http2 GET | 46,803 req/s | 0.63 ms | 1.81 ms |
| unary c=32 | apü safe op (GET) | 29,182 req/s | 1.03 ms | 1.96 ms |
| unary c=32 | apü unsafe op (POST + key) | 20,884 req/s | 1.48 ms | 2.06 ms |
| server stream 200k small msgs | raw NDJSON (split + JSON.parse) | 2,611,033 msg/s |  |  |
| server stream 200k small msgs | apü stream (frames, validated) | 1,955,323 msg/s |  |  |
| server stream 200k small msgs | apü stream + zstd | 1,693,462 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 399 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 334 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.67 ms | 0.67 ms | 0.81 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.31 ms | 0.31 ms | 0.61 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 328 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 94.57 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 102 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 162 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 103 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 373 MiB/s |  |  |

#### docker-2cpu-1g

Node v26.12.1; server container: 2 CPU, 1g RAM; network: loopback → loopback; 2026-10-28T02:48Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 6,726 req/s | 0.14 ms | 0.29 ms |
| unary c=1 | apü safe op (GET) | 5,614 req/s | 0.17 ms | 0.33 ms |
| unary c=1 | apü unsafe op (POST + key) | 4,560 req/s | 0.21 ms | 0.40 ms |
| unary c=32 | raw node:http2 GET | 28,329 req/s | 1.06 ms | 2.86 ms |
| unary c=32 | apü safe op (GET) | 17,752 req/s | 1.70 ms | 3.60 ms |
| unary c=32 | apü unsafe op (POST + key) | 13,016 req/s | 2.35 ms | 4.12 ms |
| server stream 200k small msgs | raw NDJSON (split + JSON.parse) | 1,829,354 msg/s |  |  |
| server stream 200k small msgs | apü stream (frames, validated) | 1,222,537 msg/s |  |  |
| server stream 200k small msgs | apü stream + zstd | 962,626 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 194 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 164 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.75 ms | 0.75 ms | 1.11 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.39 ms | 0.39 ms | 0.62 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 173 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 51.67 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 50.14 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 76.64 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 88.26 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 209 MiB/s |  |  |

#### docker-1cpu-1g

Node v26.12.1; server container: 1 CPU, 1g RAM; network: loopback → loopback; 2026-10-28T02:48Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 6,808 req/s | 0.14 ms | 0.28 ms |
| unary c=1 | apü safe op (GET) | 5,491 req/s | 0.17 ms | 0.32 ms |
| unary c=1 | apü unsafe op (POST + key) | 4,565 req/s | 0.21 ms | 0.40 ms |
| unary c=32 | raw node:http2 GET | 28,166 req/s | 1.06 ms | 2.87 ms |
| unary c=32 | apü safe op (GET) | 17,908 req/s | 1.69 ms | 3.45 ms |
| unary c=32 | apü unsafe op (POST + key) | 12,582 req/s | 2.40 ms | 4.43 ms |
| server stream 200k small msgs | raw NDJSON (split + JSON.parse) | 1,940,950 msg/s |  |  |
| server stream 200k small msgs | apü stream (frames, validated) | 937,336 msg/s |  |  |
| server stream 200k small msgs | apü stream + zstd | 847,416 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 215 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 195 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.75 ms | 0.75 ms | 1.06 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.39 ms | 0.39 ms | 0.59 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 198 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 54.15 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 50.82 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 75.77 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 68.26 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 210 MiB/s |  |  |

#### docker-0.5cpu-256m

Node v26.12.1; server container: 0.5 CPU, 256m RAM; network: loopback → loopback; 2026-10-28T02:48Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 5,826 req/s | 0.14 ms | 0.34 ms |
| unary c=1 | apü safe op (GET) | 5,042 req/s | 0.17 ms | 0.38 ms |
| unary c=1 | apü unsafe op (POST + key) | 3,446 req/s | 0.21 ms | 0.50 ms |
| unary c=32 | raw node:http2 GET | 22,182 req/s | 1.03 ms | 3.93 ms |
| unary c=32 | apü safe op (GET) | 10,525 req/s | 1.82 ms | 50.50 ms |
| unary c=32 | apü unsafe op (POST + key) | 5,993 req/s | 2.75 ms | 65.98 ms |
| server stream 100k small msgs | raw NDJSON (split + JSON.parse) | 885,440 msg/s |  |  |
| server stream 100k small msgs | apü stream (frames, validated) | 446,649 msg/s |  |  |
| server stream 100k small msgs | apü stream + zstd | 315,655 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 84.81 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 162 MiB/s |  |  |
| 3 dependent calls | sequential calls | 0.91 ms | 0.91 ms | 1.33 ms |
| 3 dependent calls | apü batch (1 round trip) | 0.48 ms | 0.48 ms | 0.89 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 145 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 37.88 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 33.66 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 50.68 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 23.36 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 146 MiB/s |  |  |

#### docker-1cpu-1g-wan

Node v26.12.1; server container: 1 CPU, 1g RAM; network: delay 25ms rate 100mbit → 64.952 ms RTT (measured); 2026-10-28T02:50Z

| scenario | variant | result | p50 | p99 |
|---|---|---|---|---|
| unary c=1 | raw node:http2 GET | 14.68 req/s | 67.59 ms | 80.07 ms |
| unary c=1 | apü safe op (GET) | 14.22 req/s | 71.52 ms | 78.72 ms |
| unary c=1 | apü unsafe op (POST + key) | 13.94 req/s | 70.86 ms | 120 ms |
| unary c=32 | raw node:http2 GET | 407 req/s | 76.99 ms | 95.13 ms |
| unary c=32 | apü safe op (GET) | 385 req/s | 82.26 ms | 96.20 ms |
| unary c=32 | apü unsafe op (POST + key) | 378 req/s | 84.69 ms | 93.46 ms |
| server stream 100k small msgs | raw NDJSON (split + JSON.parse) | 237,949 msg/s |  |  |
| server stream 100k small msgs | apü stream (frames, validated) | 244,342 msg/s |  |  |
| server stream 100k small msgs | apü stream + zstd | 639,383 msg/s |  |  |
| bulk 1024 KiB responses | raw node:http2 (+ JSON.parse) | 6.60 MiB/s |  |  |
| bulk 1024 KiB responses | apü safe op | 6.10 MiB/s |  |  |
| 3 dependent calls | sequential calls | 203 ms | 203 ms | 218 ms |
| 3 dependent calls | apü batch (1 round trip) | 67.38 ms | 67.38 ms | 81.47 ms |
| compression, 1024 KiB JSON | identity (wire 1024 KiB) | 6.45 MiB/s |  |  |
| compression, 1024 KiB JSON | gzip (wire 320 KiB) | 8.53 MiB/s |  |  |
| compression, 1024 KiB JSON | br (wire 101 KiB) | 10.70 MiB/s |  |  |
| compression, 1024 KiB JSON | zstd (wire 118 KiB) | 11.26 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 64 KiB (RFC default) | 0.56 MiB/s |  |  |
| download 4 MiB, uncompressed | client window 4 MiB / 32 MiB (apü default) | 2.85 MiB/s |  |  |

