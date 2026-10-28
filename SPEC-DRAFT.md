# apü — draft 01

*Status: design draft, 2026-10-28, revised after nine spikes (§15). Sections say whether they are **implemented** (Node 26 spike in `src/`, tested) or **planned**. Everything implemented is covered by `npm test` (166 tests incl. real browsers).*
*Research basis: [`research/`](research/) — 01 existing-API problems, 02 HTTP/2 & modern HTTP (+ performance addendum), 03 data plane, 04 Node 26 platform, 05 verified normative details.*

ASCII identifier for media types and header names: **`apue`**.

---

## 1. Goals and non-goals

**Goals**
1. One call model covering unary, server-streaming, client-streaming and bidirectional calls, with one frame format on every transport.
2. Maximum throughput, short TTFB, compression, multiplexing, chunking, streaming.
3. **Fully HTTP/2 compatible** — defined purely in RFC 9110 semantics (methods, status, fields, content). HTTP/2 is used for multiplexing, HPACK and flow control, but nothing depends on h2 framing ⇒ HTTP/3 works unchanged (via an h3-terminating proxy/CDN — Node 26 has no built-in QUIC/HTTP/3, `node:quic` is not available), HTTP/1.1 works for everything except full-duplex request streams (verified, incl. streams over HTTP/1.1 and WebSocket Upgrade).
4. Works from all browsers via `fetch()`, through ordinary CDNs, proxies and load balancers.
5. Fix the top problems of existing styles (see §2).
6. TypeScript-first schemas; language-neutral manifest derived from them.

**Non-goals**
- A query language (GraphQL-style). Field selection is limited and cost-bounded.
- Server-side sessions or sticky connections.
- Relying on trailers, server push, 1xx responses, custom h2 frames/SETTINGS, h2c in browsers, GET with body.

## 2. Problems addressed

| # | Problem (research/01) | apü answer | Status |
|---|---|---|---|
| 1 | No unified sync + streaming + realtime model; gRPC bidi not in browsers | One frame format (§6) across fetch, native h2 duplex and WebSocket; capability tiers (§8) | implemented (T0–T3; T4 planned) |
| 2 | Expressive reads lose HTTP caching (GraphQL/gRPC POST) | Ops declare `effect`; safe ops → GET (canonical input in URL) or QUERY (RFC 10008) with POST fallback; ETag, `Cache-Control` (§5, §9) | implemented |
| 3 | No portable error/partial-failure model; errors hidden behind 200 | Unary: real status + RFC 9457. Streams: early errors as real status, later in-band END; per-lane END in batches (§7) | implemented |
| 4 | Versioning/evolution pain | Additive-only evolution, unknown input fields ignored, `Deprecation`/`Sunset` (RFC 9745/8594), manifest (§11) | implemented (rules + headers) |
| 5 | Dependent calls = N round trips | Pipelined batches with `$ref`, results streamed out of order (§10) — 2.8× faster for 3 calls at 63 ms RTT | implemented |
| 6 | Over-fetching, query DoS, per-field authZ | No query language; schema-validated field selection; output stripped to the schema (§5, §11) | implemented |
| 7 | Idempotency, retries, long-running ops | `effect` drives retry rules; `Idempotency-Key`; deadlines; resumable streams (§5, §8) | implemented |
| 8 | Agent consumption | Typed manifest + RFC 9727 api-catalog (§11) | implemented |
| 9 | LB / proxy / debuggability | Stateless (no sessions, resume tokens), heartbeats, anti-buffering headers, JSON default, SSE rendering (§6, §12) — verified through nginx | implemented |
| 10 | Large / resumable binaries | BLOB frames (no base64, chunked) for binary values in streams and responses (§6); resumable uploads via the resumable-upload draft | BLOB frames implemented; resumable uploads planned |

## 3. Transport rules

- **MUST** be correct over HTTP/1.1, HTTP/2, HTTP/3. Streaming request bodies require h2/h3 (browser limitation).
- **MUST NOT** depend on trailers, server push, 1xx, priority for correctness, stream IDs, connection affinity.
- Final status of any streamed response **MUST** be carried in-band (END frame, §6).
- Streamed responses **MUST** send `Incremental: ?1` (RFC 10036), `Cache-Control: no-store` (unless cacheable), `X-Accel-Buffering: no`, and commit headers immediately.
- Servers **MUST** send a HEARTBEAT frame if no frame has been sent for 15 s (intermediary timeouts 15–125 s).
- Servers SHOULD limit resources per connection: SETTINGS_MAX_CONCURRENT_STREAMS (apü default 256; Node's own default is unlimited), an idle-session timeout with GOAWAY (default 120 s; heartbeats count as activity), a time limit for unary request bodies (default 30 s → 408) and per-message size limits (413).
- New header fields **MUST** be RFC 9651 Structured Fields with stable names and low-cardinality values (HPACK/QPACK).

## 4. Operations

An operation is identified by a dotted name, e.g. `users.get`, and declares:

| Property | Values | Effect |
|---|---|---|
| `effect` | `safe` · `idempotent` · `unsafe` | HTTP method, cacheability, retry and 0-RTT eligibility |
| `stream` | `none` · `server` · `client` · `bidi` | body framing and transport tier |
| `input` / `output` | schema (`t.*`) | validation (both sides), output stripping, manifest; limits live in the schema (`t.array(x, {max})`, string lengths) |
| `cache` | `maxAge`, `staleWhileRevalidate`, `private` | `Cache-Control` for safe ops |
| `resumable` | boolean | server streams with checkpoints (§8) |
| `deprecated` | `since`, `sunset`, `link` | `Deprecation`/`Sunset`/`Link` headers |
| `description` | text | manifest |

## 5. HTTP mapping

URL: `{base}/{op}` — op name in `:path` (HPACK-friendly, routable, one preflight per op).

| effect | stream | Request |
|---|---|---|
| safe | none/server | `GET {base}/{op}?i={canonical-input}` if the path ≤ 2 KiB, else `QUERY {base}/{op}` with canonical JSON body (Content-Type required, RFC 10008 §2). If QUERY is rejected with 400/403/405/501 (Envoy < 1.40, CloudFront, Akamai) → same request as `POST`; the client remembers this only if POST then fares better. `HEAD` supported wherever GET is. |
| idempotent | none | `POST` + `Idempotency-Key` (client-generated UUID, SF String); retries allowed |
| unsafe | none | `POST` + `Idempotency-Key` (client-generated); retries allowed because of the key |
| any non-safe | client/bidi | `POST`, request stream; never retried (body can't be replayed) |

- `i` = input as **RFC 8785 JCS canonical JSON**, percent-encoded → deterministic cache key.
- **Field selection** (implemented, S9): `?s=a,b.c` on any method (part of the cache key for GET; QUERY/POST carry it in the URL too), `select` per call in batches. Paths are validated against the output schema (unknown → 400 `invalid-selection` before the handler runs), at most 64, through objects, arrays, optional and nullable fields; selecting a parent absorbs children. Applied after output validation, so only schema fields can ever be selected. The ETag covers the projected body. Typed client: `pick(op, input, ['address.city'])` checks paths at compile time and returns `DeepPartial<Output>`. No query language, no joins — cost is bounded by the schema.
- Deadline: `apue-timeout: <ms>` (SF integer; WebSocket: `?timeout=`). The server aborts the handler's signal and answers 504 (`deadline-exceeded`) — also for producers that ignore the signal; client cancellation (AbortController / `break`) resets the stream and aborts the handler.
- Unary response: real HTTP status, `Content-Type: application/json`, errors as `application/problem+json`. (CBOR: planned.)
- Streaming response/request: `Content-Type: application/apue+json` (framed, §6), or `text/event-stream` (debug/EventSource rendering). (`application/apue+cbor`: planned.)
- Reserved paths: `/.well-known/apue` (manifest), `/.well-known/api-catalog` (RFC 9727), `/$batch` (§10). Everything else that is not an op can be served by the application (`fallback`), e.g. the web app itself.
- Safe responses carry a strong `ETag` (SHA-256 of the representation); `If-None-Match` → 304 (weak comparison). `Cache-Control` from the op's `cache` policy, default `no-cache` (revalidate), `private` for caller-dependent ops; non-safe and streams `no-store`. Reads advertise `Accept-Query: "application/json"`.
- Server enforces the mapping: other methods → 405 + `Allow`.
- **Idempotency-Key semantics** (draft-08): scope = op + hash(Authorization) + key; fingerprint = SHA-256 of canonical input. Same key + same payload → stored response replayed with `apue-replayed: ?1` (apü extension; the draft defines no header); different payload → 422; original still running → 409 `retryable: true`. Handler 4xx are stored; 5xx and client aborts release the key so a retry re-executes.
- **Client retries** (default 2, full-jitter backoff): transport errors, 503/429 (honouring `Retry-After`), 409 with `retryable: true` — only for safe ops or keyed requests; 504 (deadline) is not retried.
- Input is validated on the client (no request for invalid input) and on the server (400 with `fields`). Output is validated and stripped to the schema (no accidental field leaks); invalid output → 500.

**CORS position:** recommended deployment is same-origin (no preflight). Cross-origin (server option `cors`): allowed origins get `Access-Control-Allow-Origin` (echoed, `Vary: origin`), `Access-Control-Expose-Headers` (etag, apue-replayed, deprecation, sunset, link, retry-after, accept-query, content-encoding) and `Timing-Allow-Origin`; preflights answer 204 with methods `GET, HEAD, POST, QUERY`, only the apü request headers that were asked for, and `Access-Control-Max-Age: 7200` (browser caps: Chromium 7200 s, Firefox 86400 s, WebKit 600 s); disallowed origins' preflights get 403. Credentials require an explicit origin list. apü does **not** accept CORS-simple content types for non-safe ops (CSRF, cf. Apollo GHSA-2p3c-p3qw-69r4) — we pay the preflight rather than open a CSRF hole.

## 6. Framing

Streaming bodies (both directions) are a sequence of frames with an **8-byte header**:

```
 0       1       2       3       4       5       6       7
+-------+-------+-------+-------+-------+-------+-------+-------+
| type  | flags |     lane (u16 BE) |        length (u32 BE)        |
+-------+-------+-------+-------+-------+-------+-------+-------+
| payload (length bytes) ...
```

| type | Name | Payload |
|---|---|---|
| 0x00 | MSG | one encoded message (JSON/CBOR) |
| 0x01 | END | `{status, problem?, meta?}` — terminates a lane. A body that ends while a lane has no END is **truncated** and MUST be treated as an error (detects proxy cut-offs). Lane 0xFFFF reserved |
| 0x02 | BLOB | raw bytes chunk of a binary value of the *next* MSG on the same lane; flag `last` ends that value |
| 0x03 | HEARTBEAT | empty (sent after 15 s without other frames) |
| 0x04 | CHECKPOINT | resume token (§8); SSE rendering: `id:` |
| 0x05 | CREDIT | u32 messages the receiver is willing to accept (app-level flow control) — *planned* |

Flags: bit0 `compressed` (per-frame, independent context — *planned*; today compression is per stream via `Content-Encoding`), bit1 `last` (BLOB), others reserved (MUST be 0). Receivers ignore unknown frame types.

Limits (implemented): a frame header announcing more than the limit is rejected before buffering (request streams: per-message limit = `maxBodyBytes` → 413; malformed → 400; clients map undecodable responses to 502).

- **Lane** = call index in a pipelined batch (§10); 0 for single calls.
- Parser is a byte-stream state machine; DATA-frame / chunk boundaries are meaningless.
- **Binary values** (implemented, S10): schema type `t.bytes()`. For ops whose schema contains bytes, every `Uint8Array` in a message is sent as BLOB frames (64 KiB chunks, last one flagged) *before* the MSG on the same lane; the MSG references them in order as `{"$blob": k}`; look-alike data (sole member `$blob`/`$lit`) is escaped as `{"$lit": value}`. Every blob must be referenced exactly once (else malformed). No base64: measured wire overhead < 1 % for 1 MiB files. Unary ops whose output contains bytes are answered framed (MSG + BLOB + END, not cacheable); bytes in unary *inputs* are refused at definition time (a URL/JSON body can't carry them — use a client stream). Ops without bytes keep the plain `JSON.stringify` fast path and reject BLOB frames.
- Why 8 bytes and not Connect's 5: lanes are needed for batches and blobs; 3 extra bytes are noise next to the 9-byte h2 frame header.
- **SSE rendering**: `event: msg|end|checkpoint`, `id: <checkpoint>`, `data: <json>` — same semantics, for curl and devtools; BLOBs as base64 there.

## 7. Errors

- Unary: HTTP status + `application/problem+json` (RFC 9457). Generic errors use `about:blank` with the status phrase as `title`; apü protocol errors have `type` URIs under `https://apue.dev/problems/` (placeholder namespace): `validation-failed`, `unknown-operation`, `truncated-stream`, `malformed-stream`, `deadline-exceeded`, `idempotency-key-in-progress`, `idempotency-key-reused`, `failed-dependency`, `unresolvable-reference`, `invalid-batch`, `invalid-resume-token`, `invalid-selection`. Extension members: `retryable` (bool), `fields` (per-field validation errors). Unexpected handler errors → 500 without details (logged server-side).
- Streams: if the stream fails before its first item and within the **commit window** (server-chosen, default 50 ms), the server answers with a real HTTP status + problem+json — visible to proxies and dashboards. Otherwise headers are committed (short TTFB) and later failures go into an END frame `{status: <http-status-code>, problem}`.
- Batches: each lane ends with its own END → partial failure is explicit. The HTTP status is 200 if the batch was *accepted*.

## 8. Streaming tiers

| Tier | Client→server | Server→client | Where |
|---|---|---|---|
| T0 | unary body | framed response stream | everywhere (baseline) |
| T1 | framed request stream, full duplex | framed response stream | Node, server↔server (`node:http2`, undici) |
| T2 | framed request stream, half duplex | after upload completes | Chrome only (`duplex: 'half'`) |
| T3 | WebSocket (RFC 6455/8441) carrying the same frames | ← | all browsers |
| T4 | WebTransport bidi stream carrying the same frames | ← | all engines since Safari 26.4; draft |

- Client selection (implemented): Node uses T1 (`http2Transport`); browsers use `autoTransport()` — fetch (T0) for everything, T2 for request streams where fetch can stream uploads (Chromium), otherwise T3. T4 (WebTransport) is planned; Node has no WebTransport server.
- **Verified in real browsers (S5, Chrome 156 and Firefox, headless):** T0 everywhere incl. h2, QUERY and preflighted custom headers, compression (zstd) and cancellation; **T2 works in Chrome, not in Firefox** (feature-detected); **T3 works in both** (full duplex verified). T4 not implemented (no WebTransport server in Node).
- **T3 (implemented):** one WebSocket per call (`wss://…/{op}`, subprotocol `apue.v0` required), carrying the *unchanged* apü frame stream in both directions inside binary messages (message boundaries are irrelevant; fragmentation allowed). Handshake via HTTP/2 extended CONNECT (RFC 8441; the server advertises `SETTINGS_ENABLE_CONNECT_PROTOCOL`) or HTTP/1.1 Upgrade. Observed: Firefox and Node's WebSocket client use RFC 8441 over the existing h2 connection. Chrome (RFC 8441 by default since M91) only *reuses* an existing h2 session with an identical session key and never opens a fresh h2 connection for a WebSocket; a cross-origin fetch without credentials has a different key (privacy mode) than the always-credentialed WebSocket, so Chrome fell back to HTTP/1.1 — with `fetchTransport(url, { credentials: 'include' })` (CORS `credentials: true`) Chrome used RFC 8441 over the shared connection (verified in S6). Same-origin deployment gets this by default. Origin is checked against the CORS list (or same-origin) to prevent cross-site WebSocket hijacking. Browsers can't set WebSocket headers, so the deadline is `?timeout=ms`; errors (including handshake-independent ones like 404/415) arrive in-band as END frames; the server closes with 1000 after END, 1001 on shutdown; the client closes with 4000 to cancel. Text frames → 1003, unmasked/invalid frames → 1002. `autoTransport()` picks fetch for everything and WebSocket only for request streams when fetch can't stream uploads (Firefox, Safari).
- Consumer-paced streams will use **CREDIT** frames (*planned*; transport backpressure doesn't survive buffering proxies, browsers buffer 6–15 MiB). Today: HTTP/2 flow control end-to-end where no proxy buffers, plus per-stream server buffers bounded at 256 KiB.
- **Resume** (implemented, S7): ops declared `resumable: true` (server streams; safe or idempotent only, because resuming re-sends the request). The handler calls `ctx.checkpoint(cursor)` after the items the cursor covers; the server sends a CHECKPOINT frame with a self-contained token `base64url(JSON{op, 128-bit input hash, cursor, expiry}).HMAC-SHA256` (~140 bytes). After a transport loss the client re-sends the call with `apue-resume: <token>` (SSE: `id:` / `Last-Event-ID`); any replica with the shared secret verifies it (no sticky sessions, no stream state) and passes `ctx.resumeFrom`. Invalid, foreign, expired tokens or tokens for another input → 400 `invalid-resume-token` before the stream starts. Contract: from a cursor, the handler replays the same items in the same order; the client counts messages since the last checkpoint and skips that many → exactly-once delivery to the consumer (verified for 30 cut positions × 2 losses). Never resumed: END with an error, malformed frames, no checkpoint yet, budget (`resumes`, default 3) exhausted. Batch lanes and WebSocket calls are not resumable.

## 9. Caching

- Implemented: `Cache-Control` from the op's `cache` declaration (`max-age`, `stale-while-revalidate`, `private`), strong `ETag` per representation (content-coding and selection included), `If-None-Match` → 304, `Vary` for `accept`, `accept-encoding`, `origin` as applicable, HEAD.
- Planned: `CDN-Cache-Control` (RFC 9213), `Cache-Groups` (RFC 9875) for invalidation; QUERY responses with `Location` / `Content-Location` → GET-able URL. Note: no CDN caches QUERY today (research/05).

## 10. Pipelined batches (promise pipelining)

`QUERY {base}/$batch` (only if every call is `safe`, else 422) or `POST {base}/$batch`, `Content-Type: application/json` (not `/`: that path must stay free for serving the app same-origin; op names start with a letter, so `$batch` can't collide):

```json
{ "calls": [
  { "op": "users.get",   "in": { "id": "42" } },
  { "op": "orders.list", "in": { "userId": { "$ref": [0, "id"] } } },
  { "op": "orders.create", "in": { "item": "x" }, "key": "1f0c…" }
] }
```

- **References**: an object with exactly one member `"$ref": [lane, ...path]` is replaced by the output of an earlier call (path segments: member names or array indices; own properties only; `__proto__`/`constructor`/`prototype` rejected). Data that would look like a reference (exactly one member named `$ref` or `$lit`) is escaped as `{"$lit": value}`; `$lit` content is taken verbatim.
- **Structural validation first** (all-or-nothing `400 invalid-batch`): 1..64 calls (server-configurable), known ops, no request-stream ops, references only to *earlier* calls (⇒ acyclic) and only to unary (`stream: none`) calls, valid `key`.
- **Execution**: each call starts once its dependencies finished; independent calls run concurrently. Inputs are validated after reference resolution (400 `validation-failed`; missing path → 400 `unresolvable-reference`).
- **Response**: always a framed stream, headers committed immediately; each lane delivers `MSG… END` as soon as it completes (out of order) → TTFB = fastest call. Server-streaming ops may be batched (lane carries many MSGs).
- **Failures are per lane**: a failed call ENDs with its problem; dependents END with `424 failed-dependency` (transitively); independent lanes are unaffected. A lane without END when the body ends is truncated (client: 502).
- **Idempotency**: non-safe calls carry a per-call `key` (client-generated), scoped like `Idempotency-Key` → resending the same batch replays keyed calls, so batches are retry-safe as a whole.
- `apue-timeout` applies to the whole batch; cancelling the request aborts all running calls.
- Batching is for **dependencies**; independent calls should just be separate requests multiplexed on h2.
- Client API: `const b = client.batch(); const u = b.call('users.get', {id}); const o = b.call('orders.list', {userId: u.ref('id')}); await b.send(); await o.result` — `ref()` is typed along the output type (up to 3 path segments, through optional fields).
- Later: `$map` over arrays (Cap'n Web-style).

## 11. Schemas, manifest, evolution

- Schemas are TS objects built from a small erasable-syntax builder with static type inference — no codegen for TS clients.
- `GET {base}/.well-known/apue` → manifest: ops, effects, stream kind, JSON Schema for input/output, cache policy, deprecation, resumability. `ETag` = manifest hash, `no-cache`.
- `GET|HEAD /.well-known/api-catalog` (RFC 9727, implemented): `application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"` with a `service-desc` link to the manifest, and `Link: </.well-known/api-catalog>; rel="api-catalog"` — generic discovery for crawlers and agents.
- **Typed clients without the server's sources** (implemented, S11): `node bin/apue-types.ts <base-url>` turns the manifest into a `defineApi(...)` module with the same `t.*` schemas; verified by a round trip (API → manifest → generated code → identical manifest). The generator rejects JSON Schema keywords it can't express instead of silently dropping constraints.
- Evolution: only additive changes within a major; removal via `deprecated` → `Deprecation`/`Sunset` headers.
- Limits are part of the schema (list max, select depth) → cost is bounded statically.

## 12. Data plane & performance guidance

- **Encoding**: JSON (V8-native, debuggable; no replacer/reviver in the hot path); bigint/decimal as strings. CBOR via `Accept` is planned, and only worth it with schema-compiled codecs (research/03: generic binary decoders in JS reach ~1–3× `JSON.parse`).
- **Compression** (implemented, measured — docs/benchmarks.md): `Accept-Encoding` negotiation (q-values; server preference zstd > br > gzip). Defaults zstd-3, brotli-4, gzip-1 (brotli-11 runs at ~1 MiB/s: never dynamic). Unary bodies ≥ 1 KiB, off the event loop ≥ 64 KiB; `Vary: accept-encoding`; ETag per content-coding. Streams: compressor flushed after every frame burst (TTFB unaffected, tested per coding). On a 100 Mbit/s, 63 ms RTT link zstd gives 2.7× stream and 1.8× bulk throughput. Never mix secrets with attacker-echoed data in one stream. Optional later: RFC 9842 schema-derived dictionary.
- **HTTP/2 tuning (both ends)**: stream window 4 MiB, connection window 32 MiB (Node ≥ 26.11 `connectionWindowSize`; Node 26.12.1 still defaults to 64 KiB, which costs 12× download throughput at 63 ms RTT), frames ≤ 16 KiB, TCP_NODELAY, frames coalesced into one write per event-loop turn (≤ 16 KiB), up to 256 KiB buffered per stream before the producer waits for `drain`.
- **Headers**: op in `:path`; few stable SF headers; one entropy field; compact auth tokens.

## 13. Open questions

Resolved:
- `idempotent` ops: POST + key, not PUT (PUT means "replace the target resource").
- QUERY through CDNs: CloudFront (403) and Akamai (501) reject it, nginx/Envoy ≥ 1.40/HAProxy/Fastly forward it, none cache it → client falls back to POST; verified through nginx 1.31.8.
- Browser duplex without request streaming: WebSocket tier T3 instead of correlated request pairs (no shared state needed).
- Compression: per stream via `Content-Encoding` with per-burst flush (measured: TTFB unaffected).
- Projection syntax: dotted paths validated against the output schema.

Open:
1. CBOR encoding and schema-compiled codecs — worth it only where CPU, not network, dominates.
2. Resumable uploads (draft-ietf-httpbis-resumable-upload) and out-of-band URLs for very large binaries; idempotency replay for ops with bytes outputs (stored responses are JSON today).
3. CREDIT frames for consumer-paced bidi streams.
4. WebTransport (T4) once a server implementation exists for Node; HTTP/3 in Node.
5. Problem type namespace (placeholder `https://apue.dev/problems/`).
6. Auth: out of scope (standard `Authorization`), or define token-binding guidance? (Idempotency keys are already scoped per credentials.)
7. Long-running operations: resumable streams cover progress + result; is a separate pattern needed?
8. Generators for other languages (the manifest is JSON Schema; TypeScript generation exists).

## 14. Spikes (Node 26, native TS, no build step)

| Spike | Goal | Status |
|---|---|---|
| S0 | Skeleton: `type: module`, typecheck-only `tsconfig`, `node --test` | ✅ |
| S1 | Frame codec, h2 server streaming, Node client, TTFB | ✅ |
| S2 | Schemas, op registry, HTTP mapping (GET/QUERY/POST), JCS, problem+json, ETag, idempotency | ✅ |
| S3 | Pipelined batches with `$ref`, out-of-order lanes, 424 | ✅ |
| S4 | Benchmarks (local, constrained Docker, WAN emulation), profiling, compression | ✅ |
| S5 | CORS; real-browser tests (Chrome, Firefox) | ✅ |
| S6 | Fuzzing; tier T3 (WebSocket, RFC 8441/6455) | ✅ |
| S7 | Resumable streams | ✅ |
| S8 | Real intermediary (nginx) | ✅ |
| S9 | Field selection, resource limits, example app, api-catalog | ✅ |

Dependencies: none at runtime; `typescript` + `@types/node` as devDependencies for typechecking only.

## 15. Spike log

### S0 + S1 — 2026-10-28 ✅

Implemented: `src/frame.ts` (codec, web-only), `src/server.ts` (node:http2 compat API, h1 fallback), `src/client.ts` (fetch transport), `src/transport-http2.ts` (T1 full duplex). 31 tests (`node --test`), typecheck clean (`tsc`, erasable syntax only).

Validated:
- Frame decoder is independent of chunk boundaries (every split point + byte-by-byte); oversized frames rejected from the header alone.
- Unary, server-stream, client-stream over **fetch and node:http2**, both on TLS + h2; HTTP/1.1 fallback for unary.
- **Full duplex (T1)** over a single h2 stream with `node:http2`: each echo arrives before the next input is sent.
- In-band mid-stream errors; early errors → real HTTP status (commit window); deadline → 504; client `break` → server signal aborted (RST_STREAM); heartbeats while idle; SSE rendering.

Measured (`node scripts/ttfb.ts`, loopback, Node 26.12.1, 20 rows × 10 ms):

| | TTFB p50 | total p50 |
|---|---|---|
| unary, buffered (fetch) | 219.6 ms | 219.6 ms |
| apü stream (fetch) | **12.0 ms** | 220.2 ms |
| unary, buffered (http2) | 220.3 ms | 220.3 ms |
| apü stream (http2) | **11.7 ms** | 219.8 ms |

Small-message stream throughput (200k msgs, h2 transport): 563k msg/s with 16 KiB coalescing vs 520k msg/s without (+8%). Loopback hides syscall/RTT cost; per-message JSON + async-generator overhead probably dominates → S4 to profile.

Platform findings:
- Node 26.12.1 still defaults `initialWindowSize` to 65,535 → apü sets 4 MiB stream / 32 MiB connection (`connectionWindowSize` works).
- HTTP/2 sockets can't be touched via the session (`ERR_HTTP2_NO_SOCKET_MANIPULATION`) → TCP_NODELAY set on the server's `'connection'` event.
- On RST_STREAM the h2 compat layer marks `res` finished *before* `'close'` and `res.destroyed` is undefined → cancellation needs an explicit completion flag.
- `http2.Server.close()` waits for open sessions (fetch keeps them alive) → close sessions (GOAWAY) + keep-alive sockets explicitly.
- `tls.setDefaultCACertificates()` makes built-in fetch trust a dev cert at runtime (no `NODE_EXTRA_CA_CERTS`).

### S2 — 2026-10-28 ✅

Implemented: `src/schema.ts` (TS-first schema builder: validation, static inference, JSON Schema), `src/api.ts` (`op`/`defineApi`, effect → method rules, RFC 8785 canonical JSON), `src/idempotency.ts` (in-memory store), server rewrite (contract-driven mapping, ETag/304, cache policy, HEAD, Accept-Query, Deprecation/Sunset/Link, manifest at `/.well-known/apue`, output stripping), typed client (`ApueClient<typeof api>`, no codegen) with method selection, QUERY→POST fallback, idempotency keys and retries.

Tests: 82 (`schema`, `idempotency`, `http-mapping`, plus S1 suites ported to typed APIs), including RFC 8785 test vectors and type-level `@ts-expect-error` checks.

Findings:
- `op()` needed overloads: with a defaulted `S` type parameter, the contextual type from `defineApi` widened `stream` to the whole union.
- Returning an *unstarted* async-generator body iterator does not run its `finally` → the h2 stream stayed open and `server.close()` hung. Fixed with a per-attempt AbortController (aborting resets the stream).
- fetch wraps errors thrown by a streaming request body as `TypeError: fetch failed` with the original in `cause` → unwrapped in the fetch transport.
- `QUERY` works on Node 26.12.1 over h1 (llhttp) and h2, from fetch and node:https.

### S3 — 2026-10-28 ✅

Implemented: `src/refs.ts` (reference encoding/escaping/resolution), server batch endpoint (structural validation, dependency scheduling, per-lane streaming, 424 propagation, per-call idempotency through a shared `runUnary`), `src/batch.ts` (typed client batch API with `ref()`, `BatchCall.result`, `BatchStream`).

Tests: 97 total; batch suite covers dependency chains in one request (QUERY), out-of-order delivery and concurrency (fast lane < 200 ms while 2×300 ms lanes finish in < 550 ms), transitive 424, post-resolution validation, unresolvable refs, `$ref`/`$lit` escaping, streaming lanes, per-call keys and replay on resend, cancellation reaching handlers, batch-wide deadline, truncated lanes, 10 structural error cases, prototype-pollution guards.

Findings:
- `ref()` path typing must strip `undefined` at every step (optional fields), else the next key is `never`.
- Transports report aborts differently (fetch rejects with the abort reason, node:http2 with a generic `AbortError` whose `cause` is the reason) → the client rethrows the caller's `signal.reason`.
- Refactoring unary execution into one never-throwing `runUnary` made HTTP calls and batch lanes share idempotency, validation and error semantics.

### S4 — 2026-10-28 ✅

Implemented: `bench/` (separate-process harness with raw node:http2 baselines, micro-benchmarks, CPU-profile summariser, report generator, Docker profiles with CPU/RAM limits and netem), `src/exchange.ts` (core HTTP/2 API, compat only for HTTP/1.1), `src/compression.ts` + streaming compression, profile-driven optimizations. Results and methodology: [`docs/benchmarks.md`](docs/benchmarks.md).

Bugs found by benchmarking/profiling and fixed with regression tests: O(n) idempotency eviction; backpressure deadlock when the sink high-water mark exceeds the buffer limit; stuck producers outliving the deadline (streams and batch lanes); `server.close()` hanging when clients already closed their sessions; `for await` over request bodies resetting the HTTP/2 stream on early exit (`destroyOnReturn`).

### S5 — 2026-10-28 ✅

Implemented: CORS (`cors` server option), `test/browser.test.ts` driving **headless Chrome via CDP and Firefox via WebDriver BiDi** with only Node built-ins (WebSocket client, `module.stripTypeScriptTypes` to serve `src/*.ts` to the browser — no bundler). 11 in-browser checks per browser against a cross-origin apü server. Safari not automated (safaridriver needs `sudo safaridriver --enable`).

Totals after S5: 127 tests (`node --test`), all passing repeatedly; typecheck clean.

### S6 — 2026-10-28 ✅ fuzzing + tier T3 (WebSocket)

- Seeded fuzz tests (frame decoder, random JSON/query/stream bodies); fixed: garbage request streams surfaced as 500 → now 400/413; clients map undecodable responses to 502.
- `src/websocket.ts` (RFC 6455 framing, background reader with bounded buffering, ping/pong, close handshake), `WsExchange` (a WebSocket call runs through the same handler as HTTP), `src/transport-ws.ts` (`webSocketTransport`, `autoTransport`). Found on the way: a JSON body was read to its end before the Content-Type check — over WebSocket that end never comes; the check now happens first.
- 144 tests, incl. RFC 6455 protocol details over a raw HTTP/1.1 TLS socket and T3 full duplex in Chrome and Firefox.

### S7 — 2026-10-28 ✅ resumable streams

`src/resume.ts` (HMAC tokens), `resumable` ops with `ctx.checkpoint()` / `ctx.resumeFrom`, client resume loop with exactly-once skipping, SSE `id:`/Last-Event-ID. Found by the tests: checkpoints follow their items, so a loss between an item and its checkpoint caused a duplicate on resume → client-side skip count. Also in this round: per-request ERR_STREAM_DESTROYED from discarding request bodies too early (fixed, +12% unary), event-based unary body reading (+4–6%), a hang when a 409 body had been read for the retry check (fixed; `npm test` now has a 60 s test timeout). 154 tests.

### S8 — 2026-10-28 ✅ real intermediaries

nginx (Docker) between client and server, default and tuned configs: [`docs/intermediaries.md`](docs/intermediaries.md). Defaults pass everything request/response-shaped incl. QUERY, stream TTFB (thanks to `X-Accel-Buffering: no`; `Incremental` is ignored), cancellation and zstd; full duplex (request buffering) and WebSockets need `proxy_request_buffering off` and upgrade headers. Also: `maxConcurrentStreams` default 256 (Node's is unlimited; verified clients queue/open connections instead of failing).

### S9 — 2026-10-28 ✅ field selection, resource limits, example

Field selection (`src/select.ts`, typed `pick()`), idle-session and body timeouts, `maxConcurrentStreams` default, `/$batch` (found while building `examples/todo`: a batch endpoint at `/` blocked serving the app same-origin), server `fallback` hook, todo example tested end to end and in Chrome.

### S10 — 2026-10-28 ✅ binary values

`t.bytes()`, `src/blobs.ts` (split/escape, chunking, assembler), BLOB frames in server streams, framed unary responses, request streams (HTTP/2 and WebSocket) and batch lanes. Found by the tests: unescaping `$lit` must happen exactly for bytes ops — doing it for every message altered user data in batches. 177 tests.

### S11 — 2026-10-28 ✅ robustness probe, codegen, gRPC comparison

Path/header probe found two 500s (malformed percent-encoding in the op path, deadlines beyond the timer range) → 400. `src/codegen.ts` + `bin/apue-types.ts` (manifest → typed API module; strict about unsupported keywords — found by its own test). Benchmark against grpc-js: 1.5× unary, 30× streaming (docs/benchmarks.md). 181 tests.

### S12 — 2026-10-28 ✅ more intermediaries, a crash fixed

Caddy 2.11.7, HAProxy 3.4.7 and Envoy 1.40.2 added to the probe (docs/intermediaries.md): Caddy and HAProxy pass all checks with default configs; Envoy needs `upgrade_configs` for WebSockets. Envoy surfaced a crash: resets with error codes other than CANCEL emit `'error'` on node:http2 server streams, which was unhandled → fixed, regression test for five reset codes. 182 tests.
