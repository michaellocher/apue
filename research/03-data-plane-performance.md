# Data plane: serialization, compression, framing, TTFB, throughput (as of 2026-10-28)

Legend: **[V]** primary/near-primary source · **[S]** secondary/blog · **[I]** inference.

## 1. Serialization in JS/V8

In JS the cost that matters is building JS objects, not only parsing bytes. `JSON.parse`/`stringify` are native and tuned; JS binary decoders must beat them in JS, native addons pay C++→JS crossing.

**JSON**
- V8 `JSON.stringify` fast path (Aug 2025): >2× faster from V8 13.8; lost with `replacer`, `space`, custom `toJSON`, indexed keys [V] https://v8.dev/blog/json-stringify → no replacer/reviver in the hot path [I].
- JSON.parse source text access (`context.source`, `JSON.rawJSON`) Stage 4 [V] https://tc39.es/proposal-json-parse-with-source/ → lossless bigint/decimal. Revivers are slow [I].
- simdjson in Node is *slower* than `JSON.parse` when you need the full object; only helps for lazy/selective access [V] https://cdn.jsdelivr.net/npm/everything-json@1.2.1/doc/Introduction.md
- NDJSON: trivially streamable, debuggable, text-only [I].

**Binary in JS** (adelost benchmark, Node 22.19, multiples of JSON speed; size raw vs JSON) [V] https://github.com/adelost/javascript-serialization-benchmark

| Library | Encode | Decode | Size |
|---|---|---|---|
| avsc (Avro) | 8–12× | 3–7× | 32% |
| msgpackr | 2–4× | 2–3× | 53% |
| cbor-x | 2–4× | 1–2× | 53% |
| protobufjs | 0.2–0.7× | 1–3× | 42% |
| google-protobuf | 0.3–0.5× | 0.8× | — |
| bson | 0.8–1× | 1–3× | 79% |
| v8.serialize | 1–2× | 0.6–1× | 61% |

- protobuf-es 2.14 (2026-08-14): schema-walk compiled codecs, up to 5× faster `toBinary`, no eval (CSP-safe) [V] https://buf.build/blog/protobuf-es-performance
- msgpackr / cbor-x "shared structures"/records: ~4× `JSON.parse` decode, but rely on eval-generated readers [V].
- **Takeaway [I]:** plain CBOR/MessagePack decode ≈ 1–3× JSON; big wins come from *schema-aware* codecs. Binary wins clearly on encode speed, raw size, bytes/bigints. After compression the size gap mostly closes — real wire wins are binary blobs (no base64 +33%) and CPU.
- CBOR (RFC 8949): IETF standard, typed tags (bigint, dates, typed arrays), CDDL (RFC 8610), deterministic encoding. MessagePack: bigger ecosystem, no IETF standard. Avro needs writer schema. FlatBuffers/Cap'n Proto zero-copy weak in JS (DataView per field).

## 2. Compression

**Content-Encoding:** `zstd` Chrome 123, Firefox 126, Safari 26.3 (OS stack; caniuse "partial") [V] https://caniuse.com/zstd. `br`/`gzip` universal.

**CompressionStream (in-JS)**

| Format | Chrome | Firefox | Safari |
|---|---|---|---|
| gzip / deflate / deflate-raw | yes | yes | yes |
| brotli | no (≤159) | 147+ | 18.4+ |
| zstd | no | flag (138+) | no |

→ browser-side request/per-message compression can only rely on gzip/deflate-raw [V].

**Node zlib:** zstd since v23.8 / v22.15, Stability 1 Experimental; flush modes `ZSTD_e_flush`, `BROTLI_OPERATION_FLUSH`, `Z_SYNC_FLUSH` [V] https://nodejs.org/api/zlib.html

**Levels/latency** (.NET 11, 292 KB JSON) [S]: zstd-1 7.26× @ ~572 MB/s; brotli-fast 7.01× @ ~215 MB/s; gzip 6.55× @ ~208 MB/s. [I] Dynamic: zstd 1–3 > brotli 4–5 > gzip 6. Don't compress < ~512 B–1 KB.

**Streaming:** must flush per message or compressor buffers (kills TTFB). Per-stream context = best ratio (shared JSON keys) but MBs of memory per stream; per-message (Connect/gRPC flag bit, no shared context) = independent, worse ratio for small messages [V] https://connectrpc.com/docs/protocol/

**Compression Dictionary Transport — RFC 9842** [V]: `Use-As-Dictionary`, `Available-Dictionary`, `dcb`/`dcz`, `Vary: accept-encoding, available-dictionary`; HTTPS, same-origin, cookie-like partitioning. Chromium 130+ only; Firefox/Safari positive positions, not shipped [S]. [I] **Schema-derived dictionary per API version** (field names, enums, common strings) = transport-level "shared structures" for plain JSON — biggest untapped lever for small JSON, optional.

**CRIME/BREACH [I]:** never share a compression context across trust/principal scopes; no secrets next to attacker-echoed content; dictionaries public/static only; per-message "do not compress" flag for secret-bearing frames.

## 3. Framing within one HTTP body

- **gRPC:** 5-byte prefix (flags + u32 BE length); status in trailers (browser-unreadable).
- **Connect:** same 5 bytes; bit0 compressed, bit1 EndStreamResponse (`{error?, metadata?}` JSON). No trailers → works with fetch. Unary = plain POST, or GET for `NO_SIDE_EFFECTS` (cacheable) [V].
- **SSE:** text, native `Last-Event-ID` reconnect; `EventSource` GET-only, no custom headers; binary needs base64.
- **NDJSON:** simplest, text-only. **multipart/mixed:** heavy, but binary parts.
- **h2 interaction [I]:** message boundaries are independent of DATA frames (default max 16,384 B) → byte-stream state-machine parser. Default window 65,535 B; Node should raise `initialWindowSize` + `session.setLocalWindowSize()`. Never use h1 chunk boundaries as framing.
- **Backpressure:** pull-based `ReadableStream`/`TransformStream` in browser propagates to h2 WINDOW_UPDATE; Node: respect `write()`/`'drain'`/`pipeline`. Eager `for await` into unbounded arrays defeats it.
- **Large binaries [I]:** no base64; either a blob-chunk envelope type referenced by ID from structured messages, or out-of-band signed GET URLs (cacheable, range-able, avoids HOL inside one stream — separate h2 streams multiplex fairly).

## 4. TTFB & latency

- **Commit headers + first frame immediately** → errors after 200 must be in-band (design for it).
- **103 Early Hints:** only top-level navigations; ignored for `fetch()` → useless for API responses [V] https://developer.chrome.com/blog/early-hints
- **0-RTT:** replayable; RFC 8470 — no unsafe methods in early data, `425 Too Early` [V] → mark ops safe/idempotent explicitly.
- **CORS preflight:** custom headers or `application/json` → extra RTT per URL+method+headers. Max-Age caps: Firefox 86,400 s, Chromium 7,200 s, default 5 s [V]; WebKit ~600 s [unverified]. Cache keyed per URL → REST `/items/123` keeps missing [I]. → same-origin, or "simple request" unary calls (`text/plain` POST, no custom headers, metadata in body/URL), or few fixed endpoint URLs.
- **Batching vs h2:** h2 removes handshake savings; batching still saves headers, dispatch, preflights and — most importantly — **dependent round trips**. Independent → multiplex; dependent → pipeline.
- **Promise pipelining:** Cap'n Proto; **Cap'n Web** (2025) brings it to JS over HTTP batch/WebSocket — batch sent at first await, `.map()` over remote arrays; HTTP batch can't return streams [S] https://github.com/cloudflare/capnweb. Strongest round-trip eliminator; natural differentiator [I].

## 5. Throughput

- grpc_bench (2022-04-23, old) [V]: node_grpcjs_st 4,133 req/s (1 CPU) vs go_vtgrpc 44,074, rust_tonic 41,546 → Node ~10× slower.
- undici README (Node 24.14.1, h2) [V]: native http2 4,905 req/s, undici request 6,831, undici fetch 3,499; h1 TLS dispatch 7,362. ~20% h2 penalty in Node core (2021 discussion).
- [I] Node h2 per-stream overhead dominates small RPCs → avoid a JS Duplex per message; coalesce small writes into ≥8–16 KB DATA frames; cork.
- "gRPC vs REST 1.5–2×" posts are low quality [S]; **no rigorous Connect/REST/GraphQL/WebSocket Node benchmark exists** → build our own harness.
- WebSocket: 2–14 B frame overhead vs 9 B h2 frame + 5 B envelope; loses HTTP semantics/caching, no flow control beyond TCP.

## Recommendations for the data plane

1. **JSON default; optional CBOR** with schema-compiled (no-eval) codecs; canonical JSON profile (bigint/decimal as strings or `rawJSON`); optional protobuf mapping for gRPC interop; skip zero-copy formats for JS.
2. **5-byte envelope** (flags + u32 BE length) for streaming bodies both ways. Flags: compressed, end-of-stream (status/error/metadata), binary-blob chunk, reserved. Blobs split into chunk envelopes referenced by ID. Debug mode 1:1 to NDJSON/SSE. Unary = plain body; idempotent → GET with deterministic query encoding.
3. **In-band status/errors**; commit headers immediately.
4. **Compression:** `Accept-Encoding` per stream, zstd 1–3 → br 4–5 → gzip; off < ~1 KB; per-stream context + flush per message (or 1–5 ms coalescing); per-message mode for many idle streams / mixed trust; no secrets beside attacker data; browser request compression gzip/deflate-raw only; optional RFC 9842 schema dictionary.
5. **Round-trip elimination:** built-in promise pipelining; batch only for dependency graphs; explicit safe/idempotent marking (GET caching, 0-RTT, idempotency keys); CORS-free design; no Early Hints reliance.
6. **Flow control/backpressure** via WHATWG Streams, pull-based decoding; Node: raise windows, coalesce writes, no per-message stream objects.
7. **Transports:** h2/h3 fetch primary; WebSocket/WebTransport for browser full-duplex; same envelope everywhere.
8. **Benchmark harness** before freezing defaults (JSON vs CBOR vs protobuf-es, ± compression, unary vs streaming, h1 vs h2).
