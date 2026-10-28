# HTTP/2 and modern HTTP as a protocol foundation (as of 2026-10-28)

Legend: **[V]** verified against primary source (RFCs, Datatracker, MDN browser-compat-data); **[R]** reported by secondary source; **[I]** inference.

## 1. HTTP/2 capabilities (RFC 9113 / RFC 9110)

- **Multiplexing / stream lifecycle [V]** — one stream per exchange; odd client IDs never reused; ID exhaustion forces a new connection. HTTP semantics (RFC 9110) unchanged — only framing is new.
- **Flow control [V]** — per-stream + per-connection WINDOW_UPDATE, initial window 65,535 bytes. Streams don't block each other at h2 layer, but share one TCP connection.
- **HPACK (RFC 7541) [V]** — static + dynamic table (default 4,096 bytes). Repeated identical fields → ~1 byte; unique-per-request values don't compress. "Never-indexed" literals for secrets. [I] Keep header names stable and values low-cardinality; few per-request random fields.
- **RST_STREAM [V]** — per-stream cancel without killing the connection. REFUSED_STREAM ⇒ no processing happened ⇒ safe to retry. Reachable from browsers via `AbortController`.
- **Trailers [V]** — on the wire yes; **not exposed to JS**.
- **Priorities [V]** — RFC 7540 tree deprecated; **RFC 9218** `Priority: u=0..7, i`. Header sent by Chrome 124+, Firefox 128+, not Safari. fetch `priority` option: Chrome 101, Firefox 132, Safari 17.2. Hints only.
- **Server push: dead [V]** — Chrome disabled in 106 (2022; 99.95% of connections never got a push); Firefox removed in 132 (2024-10-29). Never exposed to fetch().
- **Extended CONNECT (RFC 8441; RFC 9220 for h3) [V]** — WebSockets over h2: Chrome 67+, Firefox 65+, Safari 14.1+ [R]. No browser does WS over h3 [R]. Some servers reject (Spring 405) [R].
- **1xx / 103 Early Hints [V]** — Chrome 103, Firefox 120 (preload 123), Safari 17 (preconnect only). fetch() does **not** surface 1xx to JS.
- **h2c [V]** — `Upgrade: h2c` deprecated; browsers only do h2 over TLS/ALPN. Prior-knowledge h2c only server-to-server.
- **MAX_CONCURRENT_STREAMS [V]** — no default, ≥100 recommended. AWS ALB 128/conn; Cloudflare up to 200 to origin.
- **GOAWAY [V]** — last-stream-id: higher IDs safe to retry. Graceful: two GOAWAYs (~1 RTT apart; Envoy drain 5 s). Streams ≤ last-id need idempotency to retry.

## 2. What browsers expose via fetch() (2026-10)

| Capability | Chrome | Firefox | Safari |
|---|---|---|---|
| Response body streaming | 43 | 65 | 10.1 |
| Request body streaming (`duplex:'half'`) | **105** | **Nightly only** | **No** |
| Full-duplex fetch | No | No | No — whatwg/fetch#1254 open, "needs implementer interest" |
| Trailers readable from JS | No | No | No |
| WebTransport | 97 | 114 | **26.4 (Mar 2026)** |
| WebSocketStream | 124 | No | No |
| WebSocket over h2 | yes | yes | 14.1+ [R] |
| No-Vary-Search | 141 | 154 | No |
| Compression dictionaries (`dcb`/`dcz`) | 130 | preview | No |
| `zstd` content-coding | 123 | 126 | 26.3 |

Chrome request-streaming restrictions [V]: rejected on HTTP/1.x; always CORS-preflighted; no redirects except 303; response unavailable until request body is complete (half-duplex); proxies/CDNs may buffer.
SSE works over h2/h3 and the 6-connection limit disappears on h2 [V].
WebTransport IETF drafts (http3-16, http2-15, 2026-07-06) in WG Last Call [V]; no browser does WebTransport-over-h2 [R].

## 3. Intermediaries

| | h2 to origin | Trailers | Streaming / timeouts |
|---|---|---|---|
| **Cloudflare** | default on if origin ALPN `h2` [V] | gRPC only (opt-in) [V] | Proxy read timeout 125 s (Ent. up to 6000 s); idle 900 s [V] |
| **AWS ALB** | opt-in (`HTTP2`/`gRPC` target group); default HTTP/1.1 [V] | under gRPC protocol version [V] | idle 60 s; all streaming modes with h2/gRPC targets [V] |
| **CloudFront** | **HTTP/1.1 to custom origins** (gRPC mode excepted: POST-only, uncached) [V] | **strips `Trailer`/`TE`** [V] | **GET with body → 403**; request ≤32 KB incl. headers; URL ≤8 KB [V] |
| **nginx** | `proxy_http_version 2` only since 1.29.4 [V] | `proxy_pass_trailers` since 1.27.2, off by default [V] | request + response buffering on by default (`X-Accel-Buffering: no`); `proxy_read_timeout` 60 s [V] |
| **Envoy** | full h2 upstream [V] | yes | route timeout **15 s** default (set 0 for streams); stream idle 5 min [V] |
| **Fastly** | unconfirmed for Delivery [R] | unconfirmed | `first_byte_timeout` 15 s; streaming miss must have max duration [V] |

[I] Client→edge is reliably h2/h3; **edge→origin often HTTP/1.1** with 15–125 s timeouts. Most fragile: trailers, request-body streaming, long-lived streams, unusual method/body combos. **RFC 10036 Incremental Forwarding (Aug 2026)**: `Incremental: ?1` asks intermediaries not to buffer (refusal = 501 + `Proxy-Status: incremental_refused`); unaware intermediaries still buffer.

## 4. Building blocks to reuse

| Spec | Status (2026-10-28) | Notes |
|---|---|---|
| **QUERY method** | **RFC 10008**, Proposed Standard, Jun 2026 [V] | safe+idempotent with body; cache key includes content; `Accept-Query`; `Location` → GET-able equivalent; preflighted; CDN support immature [I] |
| Problem Details | RFC 9457 [V] | `application/problem+json` |
| Structured Field Values | RFC 9651 (Sep 2024) [V] | adds Date, Display String |
| HTTP Message Signatures | RFC 9421 [V] | |
| Digest Fields | RFC 9530 [V] | unencoded-digest draft in RFC Editor queue |
| Idempotency-Key | draft-ietf-httpapi-idempotency-key-header-**08** (2026-10-22), not RFC [V] | pin semantics in own spec |
| Resumable uploads | draft-ietf-httpbis-resumable-upload-**14** (2026-10-18) [V] | `Upload-Offset`, `Upload-Complete`, 104 (invisible to fetch) |
| RateLimit headers | draft-11 (2026-05-23) [V] | provisional |
| Deprecation / Sunset | RFC 9745 / RFC 8594 [V] | |
| Caching / targeted CC | RFC 9111 / RFC 9213 [V] | `stale-while-revalidate` everywhere |
| Cache Groups | RFC 9875 (Oct 2025) [V] | group invalidation |
| No-Vary-Search | draft-10, RFC Editor queue [V] | |
| Compression Dictionary Transport | **RFC 9842** (Sep 2025) [V] | Chrome 130 only |
| Incremental Forwarding | **RFC 10036** (Aug 2026) [V] | |
| Web Linking / Link-Template / api-catalog | RFC 8288 / RFC 9652 / RFC 9727 [V] | |
| HTTP/3 / QUIC | RFC 9114 / RFC 9000 [V] | QPACK, no TCP HOL; needs h2 fallback |
| SSE | WHATWG HTML | robust through intermediaries [I] |

**h2 → h3 carry-over [I/V]:** design on RFC 9110 semantics only ⇒ works unchanged on h3. Anything relying on h2 framing (stream IDs as app IDs, SETTINGS hacks, custom frames, inter-stream ordering) does not.

## 5. Pitfalls

- **TCP head-of-line blocking** under h2 on lossy links [V]; h3 fixes it.
- **Rapid Reset CVE-2023-44487** and **MadeYouReset CVE-2025-8671** (2025-08-13) [V] → [I] high-rate cancel-and-reissue patterns may trip anti-abuse heuristics.
- **CONTINUATION flood VU#421644** (2024-04-03) [V] → large header blocks increasingly rejected.
- **Header limits** — CloudFront 32 KB total / 8 KB URL; nginx `4 8k`. Safe envelope ≈ 8 KB/field, 16–32 KB total [I].
- **Timeouts** — ALB 60 s, nginx 60 s, Envoy 15 s route / 5 min idle, Fastly 15 s first byte, Cloudflare 125 s ⇒ heartbeat every ~15 s and support resume.

## Design implications

**Do**
1. RFC 9110 semantics as the contract; h2 as transport optimisation ⇒ h3 and h1.1 fallback (non-streaming) for free.
2. Final status in status line/headers or body; streams end with an **in-band terminal frame** (like gRPC-Web/Connect); RFC 9457 problems.
3. `QUERY` for safe body-carrying ops with POST fallback; `Accept-Query`; `Location` for GET-able follow-ups.
4. Every unsafe op retryable: `Idempotency-Key` + ETag/`If-Match`; exploit REFUSED_STREAM/GOAWAY.
5. New headers as RFC 9651 Structured Fields, stable names, low cardinality; secrets in `Authorization`.
6. Server→client streams in the response body (length-prefixed frames or SSE) + `Incremental: ?1`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, ~15 s heartbeats, resume tokens.
7. Browser bidi tiers: (a) unary/server-stream + separate unary uploads; (b) WebSocket; (c) WebTransport. `duplex:'half'` = Chrome-only enhancement.
8. Reuse: RFC 9457, 9530, 9421, 9745/8594, 8288, 9727, 9213, 9875, RateLimit (provisional), resumable uploads.
9. Deadline/cancellation in the protocol (SF header) ↔ AbortController ↔ RST_STREAM.
10. RFC 9218 `Priority` as hint, never for correctness.

**Don't**
1. Depend on trailers. 2. Depend on server push. 3. Assume full-duplex fetch or non-Chrome request streaming. 4. Assume h2 end-to-end. 5. Use GET-with-body, invent methods beyond QUERY, custom frames/SETTINGS, h2c in browsers. 6. Rely on 1xx for browsers. 7. Design for high-rate cancels or huge header blocks. 8. Hold silent long-lived streams. 9. Use stream IDs / connection affinity as application state.

## Key sources

RFC 9113, 9110, 9218, 8441, 9220, 9114 · https://datatracker.ietf.org/wg/httpbis/documents/ · https://datatracker.ietf.org/wg/httpapi/documents/ · https://datatracker.ietf.org/wg/webtrans/documents/ · https://github.com/mdn/browser-compat-data · https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests · https://github.com/whatwg/fetch/issues/1254 · https://developers.cloudflare.com/speed/optimization/protocol/http2-to-origin/ · https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html · https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html · https://nginx.org/en/docs/http/ngx_http_proxy_module.html · https://www.envoyproxy.io/docs/envoy/latest/faq/configuration/timeouts · https://www.fastly.com/documentation/guides/concepts/real-time-messaging/streaming-miss/ · https://kb.cert.org/vuls/id/421644

Open/unverified: Fastly h2-to-origin & trailers; Cloudflare non-gRPC trailers & request buffering; Safari WS-over-h2 version; WebTransport `:protocol` interop.

---

# Performance addendum (duplex, flow control, frames, HPACK, cancellation, TTFB)

## Full duplex
- Wire (RFC 9113 §8.1): directions independent; server may respond before client END_STREAM → true full duplex (gRPC bidi) [V].
- Browsers: none do full duplex; Chrome `duplex:'half'` only resolves response after upload completes. whatwg/fetch#1254 locked Jul 2025; a Chromium engineer: HTTP "should remain" half-duplex [V].
- Node: `node:http2` streams are full duplex; undici fetch: "must be set to 'half', it is actually a full duplex" [V]. undici `connectionWindowSize` default 524,288 [V].
- → Bidi is an optional capability tier; baseline = request → streamed response [I].

## Flow control → throughput
Per-stream throughput ≤ min(stream window, connection window) / RTT. At 100 ms RTT [I arithmetic, V defaults]:

| Window | Ceiling | Who |
|---|---|---|
| 64 KiB | ~5.2 Mbit/s | RFC default; Node `http2` before Aug 2026; nginx upload preread |
| 512 KiB | ~42 Mbit/s | undici connection window |
| 1 MiB | ~84 Mbit/s | Go `net/http2` server upload |
| 4 MiB | ~335 Mbit/s | Go transport stream; **new Node default stream window** |
| 6 MiB / 15 MiB | ~0.5 / ~1.26 Gbit/s | Chromium stream / session |
| 12 MiB | ~1 Gbit/s | Firefox |
| 32 MiB conn | ~2.7 Gbit/s | **new Node default connection window** (PR #64623, 2026-08-04; `connectionWindowSize` in v26.11.0) |

- `SETTINGS_INITIAL_WINDOW_SIZE` sets only the stream window; connection window grows only via WINDOW_UPDATE on stream 0. Receiver controls → **upload speed set by server's window** [V].
- Tune: stream ≥ BDP, connection ≥ BDP × concurrent bulk streams; prefer BDP auto-tuning (gRPC PING estimator) [I/R]. Big windows weaken backpressure and cost memory.
- "HTTP/2 Bomb" CVE-2026-49975 (HPACK bomb + window stall; nginx fix 1.29.8 `max_headers` 1000) [R].
- One TCP conn = one congestion window; lossy bulk → h3 or multiple conns [I].

## DATA frame sizing
- `SETTINGS_MAX_FRAME_SIZE` default/min 16,384 [V]; Firefox hard-codes 16 KiB; nginx slices to **8 KiB** (`http2_chunk_size`) [V].
- 9-byte header = 0.055% at 16 KiB → **larger frames buy nothing**, hurt fairness/latency, exceed one TLS record [I]. Keep ≤16 KiB; frame boundaries ≠ message boundaries.

## HPACK levers
- Static 61 entries + dynamic 4,096 B default; repeated field ≈ 1 byte; Cloudflare ~76% avg request-header savings [R].
- [I] Stable low-cardinality values; few entropy fields (combine request/trace IDs into one SF); compact auth tokens (never-indexed → re-sent in full); low header count (DoS surface); **RPC selector in `:path`**; small cold-start headers (≈14 KB IW10). Same with QPACK.

## Cancellation & backpressure
- Browser abort → RST_STREAM(CANCEL) / RESET_STREAM; Node rate-limits resets 1000 / 33/s [V].
- Over h1.1 hops cancel = close TCP; ALB converts target RST to 502 unless `routing.http2.rst_stream_error_forwarding.enabled` [V].
- Explicit **deadline header**; cancel is best-effort; no cancel-and-reissue as normal path [I].
- Backpressure is per hop; browsers buffer up to the full window (6–15 MiB) before the server sees pressure; nginx buffers both directions by default [V/I].
- → **application-level credit/acks** (cursor/sequence) for consumer-paced streams [I].

## TTFB killers
1. **CORS preflight** — any non-safelisted method (incl. QUERY), header, `application/json`, streaming body. Cache per URL+origin+credentials; caps **Chrome 7200 s, Firefox 86400 s, WebKit 600 s** (WebKit source) [V]. → same-origin, or few URLs + `Access-Control-Max-Age: 7200`.
2. **Buffering intermediaries** — nginx request+response buffering; proxy compression [V/I]. → headers immediately, `Incremental: ?1`, `no-store`/`no-transform`, `X-Accel-Buffering: no`.
3. **Nagle + delayed ACK** (40–200 ms) — Node `http` `noDelay` true since v18 [V]; set TCP_NODELAY on all hops; one write per flush.
4. **TLS record sizing** — small records first on cold connections [I].
5. **Connection setup** — TLS 1.3 1-RTT; 0-RTT only for safe/idempotent (`425 Too Early`: Chrome/Firefox yes, Safari no) [V].
6. **Edge→origin h1.1** serializes per upstream conn [V].
7. **RFC 9218 `Priority`** for ordering concurrent calls [V].

## Additional do's/don'ts
- Do: recommend window settings (stream ≥ 4 MiB, connection ≥ 16–32 MiB, auto-tune, large server initial window for uploads); frames ≤16 KiB, flush per message, coalesce writes, TCP_NODELAY; HPACK-friendly headers; app-level credit; deadline header.
- Don't: raise MAX_FRAME_SIZE for throughput; assume end-to-end backpressure/cancel; let Node full-duplex mislead browser expectations; one URL per resource for cross-origin latency-sensitive calls.

Open: Fastly h2/trailers; Cloudflare non-gRPC trailers & request buffering; Chrome buffer depth window→ReadableStream; which Node lines carry 4 MiB/32 MiB windows; Safari WS-over-h2 version; CVE-2026-49975 details (secondary).
