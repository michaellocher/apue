# apü through real intermediaries

Measured 2026-10-28 with `bench/proxy/run.sh`: Node client → **proxy** (TLS, HTTP/2 to the client)
→ apü server, all in Docker. The research (research/02, research/05) lists documented behaviour;
this file records what was actually observed. Configs: `bench/proxy/`.

## Summary

| check | nginx defaults | nginx tuned | Caddy defaults | HAProxy defaults | Envoy defaults | Envoy tuned |
|---|---|---|---|---|---|---|
| unary GET, QUERY, POST + Idempotency-Key | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| stream TTFB (first item of a 1.5 s stream) | ✓ 4 ms | ✓ 3 ms | ✓ 4 ms | ✓ 2 ms | ✓ 2 ms | ✓ 3 ms |
| client cancel reaches the backend | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| full duplex request stream (tier T1) | ✗ request buffered | ✓ | ✓ | ✓ | ✓ | ✓ |
| client stream sent as a whole | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| WebSocket (tier T3) | ✗ no upgrade headers | ✓ | ✓ | ✓ | ✗ no `upgrade_configs` | ✓ |
| zstd response passed through | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

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

Recommended configs: `bench/proxy/nginx-tuned.conf`, `bench/proxy/envoy-tuned.yaml`; Caddy and
HAProxy work as in `bench/proxy/*-defaults.*`.

## Raw results

#### nginx, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 4 ms (stream 1524 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✗ no echo for 1 within 3 s (request buffered by proxy) |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✗ WebSocket connection to wss://127.0.0.1:18443/echo.duplex failed |
| zstd response passes through | ✓ content-encoding: zstd |

#### nginx, tuned config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 3 ms (stream 1515 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| zstd response passes through | ✓ content-encoding: zstd |

#### Caddy, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 4 ms (stream 1515 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| zstd response passes through | ✓ content-encoding: zstd |

#### HAProxy, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 2 ms (stream 1514 ms) |
| cancellation reaches the backend | ✓ after 50 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| zstd response passes through | ✓ content-encoding: zstd |

#### Envoy, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 2 ms (stream 1509 ms) |
| cancellation reaches the backend | ✓ after 50 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✗ WebSocket connection to wss://127.0.0.1:18443/echo.duplex failed |
| zstd response passes through | ✓ content-encoding: zstd |

#### Envoy, tuned config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 3 ms (stream 1515 ms) |
| cancellation reaches the backend | ✓ after 50 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| zstd response passes through | ✓ content-encoding: zstd |
