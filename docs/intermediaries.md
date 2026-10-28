# apü through real intermediaries

Measured 2026-10-28 with `bench/proxy/run.sh`: Node client → **proxy** (TLS, HTTP/2 to the client)
→ apü server, all in Docker. The research (research/02, research/05) lists documented behaviour;
this file records what was actually observed. Configs: `bench/proxy/`.

## Summary

| check | nginx defaults | nginx tuned | Caddy defaults | HAProxy defaults | Envoy defaults | Envoy tuned |
|---|---|---|---|---|---|---|
| unary GET, QUERY, POST + Idempotency-Key | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| stream TTFB (first item of a 1.5 s stream) | ✓ 4 ms | ✓ 3 ms | ✓ 3 ms | ✓ 3 ms | ✓ 2 ms | ✓ 2 ms |
| client cancel reaches the backend | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| full duplex request stream (tier T1) | ✗ request buffered | ✓ | ✓ | ✓ | ✓ | ✓ |
| client stream sent as a whole | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| WebSocket (tier T3) | ✗ no upgrade headers | ✓ | ✓ | ✓ | ✗ no `upgrade_configs` | ✓ |
| zstd response passed through | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| stalled consumer: server ahead, HTTP/2 (T1) | — (request buffered) | 5.8–6.3 MiB | 9.5 MiB | 6.5–7.0 MiB | 32 MiB | 32 MiB |
| stalled consumer: server ahead, WebSocket (T3 credit) | — (no upgrade) | 4.0 MiB | 4.0 MiB | 4.0 MiB | — (no upgrade) | 4.0 MiB |

Versions:
- nginx: `nginx version: nginx/1.31.8`
- caddy: `v2.11.7`
- haproxy: `HAProxy version 3.4.7-8872a26 2026/10/14 - https://haproxy.org/`
- envoy: `version: b2d89e0ae53916f28770771fbdd49c5c99c5c5a2/1.40.2/Clean/RELEASE/BoringSSL`

## Findings

1. **Request/response-shaped traffic works through every proxy with default settings**, including
   the `QUERY` method (forwarded by all four; none caches it), idempotency keys, ETags and zstd.
2. **Streaming responses are never buffered**: nginx because apü sends `X-Accel-Buffering: no`
   (`Incremental: ?1`, RFC 10036, is ignored by all four today); Caddy, HAProxy and Envoy stream
   by default.
3. **Full duplex** works by default in Caddy, HAProxy and Envoy; nginx buffers request bodies
   (`proxy_request_buffering on`) and needs `proxy_request_buffering off`.
4. **WebSockets** need explicit configuration in nginx (Upgrade/Connection headers) and Envoy
   (`upgrade_configs`); Caddy and HAProxy proxy them by default.
5. **A proxy found a crash in apü**: when a client cancelled through Envoy, Envoy reset the upstream
   stream with `INTERNAL_ERROR` instead of `CANCEL`; node:http2 emits `'error'` for such resets and
   the unhandled event killed the apü process. Fixed (commit "Fix server crash when a peer resets a
   stream with an error code") with a regression test covering all relevant reset codes — the kind
   of bug only real intermediaries surface.

6. **HTTP/2 backpressure does not survive proxies; T3 credit does** (S17): a consumer that stalls
   for 1.5 s while the server produces 64 KiB items as fast as allowed. Direct, HTTP/2 flow control
   stops the server at the client's 4 MiB window. Through proxies each hop has its own window and
   buffers: the server got 5.8–7.0 MiB ahead through nginx and HAProxy, 9.5 MiB through Caddy and
   32 MiB through Envoy. With T3's end-to-end credit the server stopped at exactly the
   client's 4 MiB window behind every proxy that passes WebSockets. This is the measured case for
   app-level credit (spec §8: message-level CREDIT across tiers remains planned).

   Corrected at 07:39: earlier runs reported **125 MiB** through Caddy. That was an artifact of the
   probe: its items were `'x'` × 64 KiB, and Caddy's upstream transport (Go) adds `Accept-Encoding:
   gzip` on its own (Go `net/http` `Transport.DisableCompression`: requested when the request has no
   Accept-Encoding, and "transparently decoded in the Response.Body"), so the server gzipped the stream ~1000× and all of it fit inside the windows —
   nothing was buffered anywhere (a 500 MiB flood grew no container's memory; the server's stream
   log showed `encoding=gzip accept=gzip`). The probe now sends random (base64) items. Worth knowing
   in itself: behind Caddy, apü compresses responses the client never asked to be compressed (Caddy
   decompresses for the client).

Recommended configs: `bench/proxy/nginx-tuned.conf`, `bench/proxy/envoy-tuned.yaml`; Caddy and
HAProxy work as in `bench/proxy/*-defaults.*`.

## Raw results

#### nginx, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 4 ms (stream 1532 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✗ no echo for 1 within 3 s (request buffered by proxy) |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✗ WebSocket connection to wss://127.0.0.1:18443/echo.duplex failed |
| stalled consumer, HTTP/2 (T1) | TIMEOUT (8 s) |
| stalled consumer, WebSocket (T3, credit) | ✗ WebSocket connection to wss://127.0.0.1:18443/flood failed |
| zstd response passes through | ✓ content-encoding: zstd |

#### nginx, tuned config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 4 ms (stream 1530 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| stalled consumer, HTTP/2 (T1) | ℹ server 6.0 MiB ahead of a stalled consumer |
| stalled consumer, WebSocket (T3, credit) | ✓ server 4.0 MiB ahead of a stalled consumer |
| zstd response passes through | ✓ content-encoding: zstd |

#### Caddy, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 3 ms (stream 1513 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| stalled consumer, HTTP/2 (T1) | ℹ server 9.5 MiB ahead of a stalled consumer |
| stalled consumer, WebSocket (T3, credit) | ✓ server 4.0 MiB ahead of a stalled consumer |
| zstd response passes through | ✓ content-encoding: zstd |

#### HAProxy, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 2 ms (stream 1515 ms) |
| cancellation reaches the backend | ✓ after 50 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| stalled consumer, HTTP/2 (T1) | ℹ server 6.5 MiB ahead of a stalled consumer |
| stalled consumer, WebSocket (T3, credit) | ✓ server 4.0 MiB ahead of a stalled consumer |
| zstd response passes through | ✓ content-encoding: zstd |

#### Envoy, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 2 ms (stream 1524 ms) |
| cancellation reaches the backend | ✓ after 50 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✗ WebSocket connection to wss://127.0.0.1:18443/echo.duplex failed |
| stalled consumer, HTTP/2 (T1) | ℹ server 32.0 MiB ahead of a stalled consumer |
| stalled consumer, WebSocket (T3, credit) | ✗ WebSocket connection to wss://127.0.0.1:18443/flood failed |
| zstd response passes through | ✓ content-encoding: zstd |

#### Envoy, tuned config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 2 ms (stream 1525 ms) |
| cancellation reaches the backend | ✓ after 50 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| stalled consumer, HTTP/2 (T1) | ℹ server 32.0 MiB ahead of a stalled consumer |
| stalled consumer, WebSocket (T3, credit) | ✓ server 4.0 MiB ahead of a stalled consumer |
| zstd response passes through | ✓ content-encoding: zstd |
