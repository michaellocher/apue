# apü — draft 00

*Status: design draft, 2026-10-28. Nothing here is final; every MUST is a hypothesis to be validated by a spike.*
*Research basis: [`research/`](research/) — 01 existing-API problems, 02 HTTP/2 & modern HTTP (+ performance addendum), 03 data plane, 04 Node 26 platform.*

ASCII identifier for media types and header names: **`apue`**.

---

## 1. Goals and non-goals

**Goals**
1. One call model covering unary, server-streaming, client-streaming and bidirectional calls, with one frame format on every transport.
2. Maximum throughput, short TTFB, compression, multiplexing, chunking, streaming.
3. **Fully HTTP/2 compatible** — defined purely in RFC 9110 semantics (methods, status, fields, content). HTTP/2 is used for multiplexing, HPACK and flow control, but nothing depends on h2 framing ⇒ HTTP/3 works unchanged, HTTP/1.1 works for non-streaming calls.
4. Works from all browsers via `fetch()`, through ordinary CDNs, proxies and load balancers.
5. Fix the top problems of existing styles (see §2).
6. TypeScript-first schemas; language-neutral manifest derived from them.

**Non-goals**
- A query language (GraphQL-style). Field selection is limited and cost-bounded.
- Server-side sessions or sticky connections.
- Relying on trailers, server push, 1xx responses, custom h2 frames/SETTINGS, h2c in browsers, GET with body.

## 2. Problems addressed

| # | Problem (research/01) | apü answer |
|---|---|---|
| 1 | No unified sync + streaming + realtime model; gRPC bidi not in browsers | One frame format (§6) across fetch, native h2 duplex, WebSocket, WebTransport; capability tiers (§8) |
| 2 | Expressive reads lose HTTP caching (GraphQL/gRPC POST) | Ops declare `effect`; safe ops → GET (canonical input in URL) or QUERY (RFC 10008) with POST fallback; ETag, `Cache-Control` (§5, §9) |
| 3 | No portable error/partial-failure model; errors hidden behind 200 | Unary: real status + RFC 9457. Streams: in-band END frame with status + problem; per-lane END in batches (§7) |
| 4 | Versioning/evolution pain | Additive-only evolution rules, `Deprecation`/`Sunset` (RFC 9745/8594), manifest hash (§11) |
| 5 | Dependent calls = N round trips | Pipelined batches with `$ref`, results streamed out of order (§10) |
| 6 | Query DoS, authZ per field | No query language; projection only, schema-declared limits (§11) |
| 7 | Idempotency, retries, long-running ops | `effect` drives retry rules; `Idempotency-Key`; deadline; checkpoint/resume (§5, §8) |
| 8 | Agent consumption | Compact typed manifest at a well-known URL + RFC 9727 api-catalog (§11) |
| 9 | LB / proxy / debuggability | Stateless; heartbeats; `Incremental: ?1`; JSON default; SSE debug rendering (§6, §12) |
| 10 | Large / resumable binaries | Blob frames (no base64) or out-of-band URLs; resumable-upload draft for large uploads (§6) |

## 3. Transport rules

- **MUST** be correct over HTTP/1.1, HTTP/2, HTTP/3. Streaming request bodies require h2/h3 (browser limitation).
- **MUST NOT** depend on trailers, server push, 1xx, priority for correctness, stream IDs, connection affinity.
- Final status of any streamed response **MUST** be carried in-band (END frame, §6).
- Streamed responses **MUST** send `Incremental: ?1` (RFC 10036), `Cache-Control: no-store` (unless cacheable), `X-Accel-Buffering: no`, and commit headers immediately.
- Servers **MUST** send a HEARTBEAT frame if no frame has been sent for 15 s (intermediary timeouts 15–125 s).
- New header fields **MUST** be RFC 9651 Structured Fields with stable names and low-cardinality values (HPACK/QPACK).

## 4. Operations

An operation is identified by a dotted name, e.g. `users.get`, and declares:

| Property | Values | Effect |
|---|---|---|
| `effect` | `safe` · `idempotent` · `unsafe` | HTTP method, cacheability, retry and 0-RTT eligibility |
| `stream` | `none` · `server` · `client` · `bidi` | body framing and transport tier |
| `input` / `output` | schema | validation, manifest, codecs |
| `limits` | max items, max select depth, max input size | DoS bounds |
| `cache` | `max-age`, `swr`, `vary` | `Cache-Control` for safe ops |

## 5. HTTP mapping

URL: `{base}/{op}` — op name in `:path` (HPACK-friendly, routable, one preflight per op).

| effect | stream | Request |
|---|---|---|
| safe | none/server | `GET {base}/{op}?i={canonical-input}` if encoded URL ≤ 2 KiB, else `QUERY {base}/{op}` with body; if QUERY rejected (405/501) → `POST` with `Apue-Effect: safe` |
| idempotent | any | `POST` (or `PUT`?) — open question; retries allowed |
| unsafe | any | `POST`; `Idempotency-Key` RECOMMENDED; retried only with key |

- `i` = input as **RFC 8785 JCS canonical JSON**, percent-encoded → deterministic cache key.
- Projection: `s=` query parameter or `select` in body (list of field paths).
- Deadline: `Apue-Timeout: <ms>` (SF integer). Server aborts work after deadline; client maps to `AbortController` → RST_STREAM.
- Unary response: real HTTP status, `Content-Type: application/json` (or `application/cbor`), errors as `application/problem+json`.
- Streaming response/request: `Content-Type: application/apue+json` / `application/apue+cbor` (framed, §6), or `text/event-stream` (debug/EventSource rendering).
- Safe responses carry `ETag`; clients use `If-None-Match`.

**CORS position:** recommended deployment is same-origin (no preflight). Cross-origin: few URLs + `Access-Control-Max-Age: 7200`. apü does **not** accept CORS-simple content types for non-safe ops (CSRF, cf. Apollo GHSA-2p3c-p3qw-69r4) — we pay the preflight rather than open a CSRF hole.

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
| 0x02 | BLOB | raw bytes chunk for blob id = lane; flag `last` closes it |
| 0x03 | HEARTBEAT | empty |
| 0x04 | CHECKPOINT | opaque resume token (client may reconnect with `Apue-Resume`) |
| 0x05 | CREDIT | u32 messages the receiver is willing to accept (app-level flow control, §8) |

Flags: bit0 `compressed` (per-frame, independent context), bit1 `last` (BLOB), others reserved (MUST be 0).

- **Lane** = call index in a pipelined batch (§10) or blob id; 0 for single calls.
- Parser is a byte-stream state machine; DATA-frame / chunk boundaries are meaningless.
- Messages refer to blobs as `{"$blob": <lane>}` → no base64.
- Why 8 bytes and not Connect's 5: lanes are needed for batches and blobs; 3 extra bytes are noise next to the 9-byte h2 frame header.
- **SSE rendering**: `event: msg|end|checkpoint`, `id: <checkpoint>`, `data: <json>` — same semantics, for curl and devtools; BLOBs as base64 there.

## 7. Errors

- Unary: HTTP status + `application/problem+json` (RFC 9457). Extension members: `retryable` (bool), `retryAfter` (s), `fields` (per-field validation errors).
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

- Clients negotiate down: T1 → T4 → T3.
- Consumer-paced streams use **CREDIT** frames (transport backpressure doesn't survive buffering proxies; browsers buffer 6–15 MiB).
- **Resume**: CHECKPOINT tokens are self-contained (signed position), so any replica can resume — no sticky sessions.

## 9. Caching

- Safe ops: `Cache-Control` from op `cache` declaration, `ETag`, `stale-while-revalidate`; `CDN-Cache-Control` (RFC 9213); `Cache-Groups` (RFC 9875) for invalidation.
- QUERY responses MAY return `Location` / `Content-Location` → GET-able URL.

## 10. Pipelined batches (promise pipelining)

`QUERY {base}/` (all calls safe) or `POST {base}/`:

```json
{ "calls": [
  { "op": "users.get",   "in": { "id": "42" } },
  { "op": "orders.list", "in": { "userId": { "$ref": [0, "id"] } }, "select": ["id", "total"] }
] }
```

- `$ref: [lane, ...path]` references the output of an earlier call; the server resolves the dependency graph and runs independent calls concurrently.
- Response is a framed stream; each lane delivers MSG… END as soon as it completes (out of order) → TTFB = fastest call.
- If a referenced call fails, dependent lanes END with `424 Failed Dependency`.
- Batching is for **dependencies**; independent calls should just be separate requests multiplexed on h2.
- Later: `$map` over arrays (Cap'n Web-style).

## 11. Schemas, manifest, evolution

- Schemas are TS objects built from a small erasable-syntax builder with static type inference — no codegen for TS clients.
- `GET {base}/.well-known/apue` → manifest: ops, effects, stream kind, JSON Schema for input/output, limits. Linked from `/.well-known/api-catalog` (RFC 9727). `ETag` = manifest hash.
- Evolution: only additive changes within a major; removal via `deprecated` → `Deprecation`/`Sunset` headers.
- Limits are part of the schema (list max, select depth) → cost is bounded statically.

## 12. Data plane & performance guidance

- **Encoding**: JSON default (V8-native, debuggable; no replacer/reviver in hot path); bigint/decimal as strings. CBOR optional via `Accept`, later with schema-compiled codecs (no eval).
- **Compression**: standard `Accept-Encoding` on the body; zstd 1–3 → br 4–5 → gzip; skip below 1 KiB; flush after every frame (or ≤5 ms coalescing). Never mix secrets with attacker-echoed data in one context. Optional later: RFC 9842 schema-derived dictionary.
- **HTTP/2 tuning (server)**: stream window ≥ 4 MiB, connection window ≥ 32 MiB (Node ≥ 26.11 `connectionWindowSize`), frames ≤ 16 KiB, TCP_NODELAY, coalesce frames into one write per flush, no per-message stream objects.
- **Headers**: op in `:path`; few stable SF headers; one entropy field; compact auth tokens.

## 13. Open questions

1. `idempotent` ops: POST + key vs. PUT? (PUT is preflighted cross-origin either way.)
2. Do common CDNs pass `QUERY` through in 2026? Spike needed.
3. Correlated-pair duplex for browsers without WebSocket/WebTransport — needs shared state; drop?
4. Per-frame vs per-stream compression default.
5. Projection syntax (paths vs. FieldMask-like).
6. Auth: out of scope (standard `Authorization`), or define token-binding guidance?

## 14. Spike plan (Node 26, native TS, no build step)

| Spike | Goal | Validates |
|---|---|---|
| **S0** | Skeleton: `package.json` (`type: module`), typecheck-only `tsconfig`, mkcert certs, `node --test` | platform |
| **S1** | Frame codec (encode / streaming decode) + h2 server streaming + Node client; measure TTFB | §6, §3 |
| **S2** | Schema builder + op registry + HTTP mapping (GET/QUERY/POST), JCS, problem+json, ETag | §4, §5, §7, §11 |
| **S3** | Pipelined batch with `$ref`, out-of-order lanes, 424 propagation | §10 |
| **S4** | Benchmark harness: apü vs plain JSON over h2; window sizes; compression on/off; frame coalescing | §12 |
| **S5** | Browser client (fetch + ReadableStream) over TLS; T0 everywhere, T2 in Chrome, T3 WebSocket | §8 |

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
