# The remaining open items — research and decisions (2026-10-28)

Four questions researched in parallel by subagents with primary sources (labels as reported:
verified = checked in the source, measured, inference); decisions and implementation by me, each
re-checked in the code. Item by item: consumer pacing (CREDIT frames), DPoP, large downloads, CBOR.

## 1. Message-level consumer pacing (CREDIT frames) — not specified

- **What byte backpressure doesn't cover** (inference from code, measurements from
  docs/intermediaries.md): memory is bounded on every tier, but not how many items a server computes
  ahead of a slow consumer — `streamResponse` pulls the handler's iterator whenever the writer isn't
  blocked, so a 4 MiB window holds ~85k items of 50 bytes; buffering proxies let servers run 6–32 MiB
  ahead (measured), browsers buffer 6–15 MiB on fetch. Cancelling after N wastes what was computed ahead.
- **Prior art**: RSocket REQUEST_N (initial n + cumulative increments; assumes no proxies — verified,
  rsocket.io protocol), Reactive Streams `request(n)` (rule 1.1, 3.9 — verified), gRPC has no message
  flow control on the wire (verified, PROTOCOL-HTTP2.md), NATS JetStream pull fetches carry `batch`,
  `max_bytes`, `expires` per request (verified). Demand that must survive intermediaries ends up per
  request (paging, pull), not per frame.
- **Why no frame**: browsers' server streams use fetch (T0) — no request stream to carry demand; T2 is
  half duplex; on T1 demand frames queued behind request data the handler hasn't read are the bidi
  deadlock S17 avoided for T3 credit (inference).
- **Decision**: patterns in §8 (first N via `limit`/cursor; N now, more later via cancel + resume;
  interactive pacing via a bidi op with `{"more": n}`); frame type 0x05 reserved. Reopen if a measured
  workload loses meaningful work behind a buffering proxy (a server-side items-ahead cap would then
  cost no protocol at all).

## 2. DPoP (RFC 9449) — groundwork now, full profile deferred

- RFC 9449 (verified): proof JWT with `typ: dpop+jwt`, asymmetric `alg`, `jwk`, `jti`, `htm`, `htu`
  (without query and fragment), `iat`, `ath` with a token, `nonce` once issued; 12 server checks
  (§4.3); replay protection "on the order of seconds or minutes", a `jti` cache optional across
  replicas (§11.1); a fresh proof even for retries (§7.2). Nonces (§8/§9) need `DPoP-Nonce` and
  `WWW-Authenticate: DPoP error="use_dpop_nonce"` — browsers can't read handshake response headers,
  so over T3 a nonce would have to travel in-band.
- Cost (measured, Node 26): ES256 sign ≈ 23–25 µs (node:crypto), a full WebCrypto proof ≈ 45 µs,
  verify ≈ 80 µs — not the obstacle.
- Adoption (verified): Auth0, Okta, Keycloak (full since 26.4), Spring Security, Duende; Chrome DBSC
  GA on Windows (Chrome 146) covers the cookie case.
- **Decision**: no verifier, nonce flow or replay cache in apü (niche: DPoP-bound tokens plus browser
  WebSocket request streams; DBSC covers cookie apps). Groundwork (S25) so an application can do it in
  its `principal` hook today: the hook gets `method` and `url`; WebSocket calls report POST, their
  logical method, so a proof signed for `POST /op` verifies on any tier (instead of the subagent's
  proposal to normalize handshakes to GET — the hook verifies the call, not the transport); the client
  option `headers({ method, path })` adds a fresh proof per request; `apue.dpop.<compact JWS>` carries
  it over T3 (a JWS is token characters — RFC 6455 §4.1, verified); CORS allows `DPoP` and exposes
  `WWW-Authenticate` and `DPoP-Nonce`.

## 3. Very large binary outputs — download resources (to be built)

- Checked in code: a `t.bytes()` output is a whole `Uint8Array`; a unary framed response holds it
  about three times (the value, each 64 KiB chunk copied into a frame, the joined body —
  `src/frame.ts`, `src/server.ts`); with an Idempotency-Key the body is also stored. The client's
  `BlobAssembler` refuses anything above 64 MiB (`src/blobs.ts`, default `maxBytes`) and joins the
  chunks into one buffer — GB outputs don't work today. No Range on framed responses: a lost
  connection restarts the download; browsers can't hand a framed body to `<a download>`/`<video>`;
  `no-store` keeps CDNs out.
- Options: a download resource with Range (chosen) whose URL is an HMAC-signed, short-lived
  capability (like S3 presigned URLs and apü's resume tokens: stateless, any replica); rejected: a
  raw `application/octet-stream` op mode (duplicates the HTTP mapping, gains nothing); "the op returns
  a URL" stays the pattern for objects already in S3/CDNs.
- Prior art (cited by the subagent, to be spot-checked): Google `alt=media` + Range, Microsoft Graph
  pre-authenticated download URLs, RFC 9110 Range/If-Range/206/416, RFC 9530 `Repr-Digest`,
  RFC 6266 `Content-Disposition`.
- Design and implementation: §6 "Download outputs" and S26 in SPEC-DRAFT.md. Deviations from the
  subagent's proposal: a per-process registry with unguessable 128-bit ids instead of HMAC-signed
  stateless tokens (same capability semantics; replicas would need shared storage either way — not
  covered, like uploads); no spooling helper for streams yet (`fromFile`, `fromBytes`, or any object
  with `size` and `open(range)`).

## 4. CBOR — closed with measurements

Spike (measured, Node 26, this machine, 3 processes × 5 rounds, medians; cbor-x 1.6 installed for
comparison; a hand-written generic CBOR and a schema-compiled codec, both round-trip-checked against
cbor-x):

| shape | JSON enc / dec | JSON + validation | generic CBOR | cbor-x | compiled tuple |
|---|---|---|---|---|---|
| small (users.get) | 507 / 613 ns | 777 / 865 ns | 538 / 989 ns | 710 / 644 ns | 323 / 609 ns |
| 100 objects | 32 / 52 µs | 59 / 80 µs | 52 / 98 µs | 66 / 73 µs | 31 / 61 µs |
| 10k items | 0.46 / 1.06 ms | 1.27 / 1.88 ms | 1.32 / 1.67 ms | 1.45 / 1.64 ms | 0.66 / 1.08 ms |
| numbers (5k points) | 576 / 939 µs | 1.09 / 1.48 ms | 903 / 505 µs | 1030 / 712 µs | 419 / 587 µs |

- Sizes after zstd: CBOR is often *larger* than JSON (binary integers compress worse than text).
- Share of a real unary call (CPU profile of bench/server.ts at 32 concurrent calls): JSON encode +
  decode + validation ≈ 11 % (GET) / 9 % (POST + key) of server CPU — the upper bound for any codec.
  The best case (compiled tuple) saves ≈ 3 %; generic CBOR ≈ 0 %.
- Costs: two more media types and negotiation, ETags per representation, number-width and
  canonicalization rules, every client and generator, unreadable in curl/devtools/SSE; the only fast
  form (keyless tuples) breaks schema evolution.
- **Decision: closed.** Cheaper wins in the same area, without a wire change, if ever needed: fusing
  validation into encoding, and avoiding `canonicalJson` (3–10× slower than `JSON.stringify`) for
  POST fingerprints.
