# Status — 2026-10-28 (overnight session)

## Where to start

1. [`README.md`](../README.md) — what apü is, how to run the example, layout.
2. [`SPEC-DRAFT.md`](../SPEC-DRAFT.md) — draft 01; every section says *implemented* or *planned*.
3. [`docs/wire.md`](wire.md) — what it looks like on the wire (real curl output).
4. [`docs/benchmarks.md`](benchmarks.md), [`docs/intermediaries.md`](intermediaries.md) — measurements.
5. `git log` — 40+ commits, each self-contained with the reasoning in the message.

`npm test` runs 231 tests (≈ 20 s, files in parallel, incl. headless Chrome, Firefox and WebKit;
browsers are skipped if missing). `npm run typecheck` is clean.

## What exists

- **Protocol**: operations with declared effects mapped onto plain HTTP (GET/QUERY/POST/HEAD),
  RFC 9457 errors, 8-byte frames for streams with in-band END, heartbeats, SSE debug view,
  pipelined batches (`$ref`), resumable streams (stateless HMAC checkpoints), field selection,
  binary values as BLOB frames, idempotency keys, deadlines, compression (zstd/br/gzip),
  CORS, manifest + RFC 9727 catalog, codegen of typed clients from the manifest.
- **Transports**: HTTP/2 (core API) with HTTP/1.1 fallback; clients over fetch, node:http2 (full
  duplex) and WebSocket (RFC 8441/6455, with HTTP/2-style byte windows so slow consumers can't
  make the server flood browser memory); `autoTransport` picks per browser.
- **Verification**: unit, integration, fuzz, chaos, leak, real-browser (Chrome, Firefox, WebKit), real
  proxies (nginx, Caddy, HAProxy, Envoy), constrained Docker benchmarks with WAN emulation, gRPC
  comparison.

## Key numbers (details in docs/benchmarks.md)

- vs grpc-js: 1.5× unary throughput, 30× small-message streaming.
- 63 ms RTT / 100 Mbit/s: batches 3.0× faster than sequential calls, zstd streams 2.7×,
  tuned flow-control windows 5–12× (Node still defaults to 64 KiB).
- Stalled consumer, server ahead: T3 credit 4.0 MiB behind every proxy; HTTP/2 up to 125 MiB through
  Caddy (hop-by-hop windows) — docs/intermediaries.md.
- Overhead vs a hand-written node:http2 handler (which validates nothing): 62 % of its unary
  throughput locally, 75 % of its stream throughput.

## Bugs found by the verification (all fixed, all with regression tests)

| found by | bug |
|---|---|
| profiling | O(n) idempotency eviction (24 % of server CPU); per-request `ERR_STREAM_DESTROYED` from discarding request bodies too early |
| benchmarks | backpressure deadlock when the sink's high-water mark exceeds the buffer limit |
| Envoy | **server crash** when a peer resets a stream with an error code other than CANCEL |
| fuzzing | garbage request streams → 500; invalid percent-encoding / huge deadlines → 500; JSON nested ≥ 10,000 levels → 500 |
| tests | stuck producers outliving deadlines; `server.close()` hanging on closed sessions; `for await` resetting streams on early exit; hang after a 409 retry check; `$lit` unescaping user data in batches |
| building the example | the batch endpoint at `/` blocked serving the app same-origin → `/$batch` |
| browsers | Chrome only reuses an h2 session for WebSockets with an identical key (credentials mode) |
| measuring T3 | a stalled WebSocket consumer let the server push 250 MiB into client memory in 3 s (now bounded by credit windows, `apue.v1`); uploads capped by 5 ms `bufferedAmount` polling (142 → 293 MiB/s) |
| WebSocket leak test | unary calls over `webSocketTransport` answered 415 (now routed over fetch); invalid stream input surfaced as 502 over T3 instead of 400; **client crash** (`setLocalWindowSize` on a session destroyed while connecting); client resets of request streams logged as server errors (now 499) |
| code review | unbounded request-stream blob memory; bytes lost on idempotent replay; CORS `Vary`/preflight gaps; missing `Retry-After` retried with no delay; duplicate items after two losses in one resume; quadratic WebSocket buffering; WebSocket writes hanging on close; regex flags dropped from the manifest |

## Flakes found and fixed

- `examples/todo in real browsers`: the page replays earlier browsers' todos after it reports ready;
  counting mid-replay gave 102 instead of 101 (seen in Firefox). The test now waits until the list
  is stable. Chrome once threw "Inspected target navigated or closed": most likely a native form
  submit before the app's handler was installed (not verified); the test now waits for the handler.
- WebKit lost the last messages of a WebSocket stream and reported 1006 in ~1 of 10 runs: a
  server-initiated close right after the data, over RFC 8441. Reproduced with a raw WebSocket page
  (3–4 of 40), gone after letting the client close after END (0 of 40; spec §8).

## Decisions taken without you (easy to revisit)

- Operation-based, TS-first schemas, working name apü (as agreed).
- JSON default, CBOR not built (generic binary codecs aren't faster in V8; see research/03).
- 8-byte frame header (lane field for batches) instead of Connect's 5 bytes.
- Batch endpoint at `/$batch`; problem type namespace `https://apue.dev/problems/` is a placeholder.
- Cross-origin writes pay a CORS preflight instead of accepting simple content types (CSRF).
- Fixed 4 MiB stream window by default; gRPC-style auto-tuning implemented but measured no better.
- `@grpc/grpc-js` + `@grpc/proto-loader` added as dev dependencies for the comparison benchmark only.
- WebSocket tier flow control as HTTP/2-style **byte** windows with credit in WebSocket **text**
  messages, mandatory, subprotocol bumped to `apue.v1` (no deployed clients). Message-count CREDIT
  frames across all tiers stay planned (spec §8 explains why bytes first and why not in-band).
- Window defaults: browser `receiveWindow` 4 MiB, server `webSocketWindow` 1 MiB (uploads ≤ window /
  RTT, ~16 MiB/s at 63 ms RTT — raise it for fast long links).
- `webSocketTransport` sends calls without a request stream over fetch (unary over WebSocket had
  no way to carry a JSON body or GET input).
- Small WebSocket client frames are coalesced (2.2× small-message uploads); adopted after the WebKit
  close race was fixed (docs/benchmarks.md, step 5).

## Open (spec §13)

CBOR · message-level CREDIT (T3 byte windows done) · WebTransport (no Node server) · HTTP/3 in Node (no `node:quic`) ·
resumable uploads · generators for other languages · problem-type namespace · auth guidance.
(Done since the first draft: CDN cache headers (S15), the long-running-operation pattern (S14).)
