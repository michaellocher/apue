# apü through real intermediaries

Measured 2026-10-28 with `bench/proxy/run.sh`: Node client → **nginx** (TLS, HTTP/2 to the client,
HTTP/1.x to the origin) → apü server, all in Docker. The research (research/02, research/05) lists
documented behaviour; this file records what was actually observed.

Version: `nginx version: nginx/1.31.8`

#### nginx, defaults config

| check | result |
|---|---|
| unary GET (safe op) | ✓ |
| QUERY method (large read) | ✓ forwarded |
| unsafe POST + Idempotency-Key | ✓ |
| stream: first item before the stream ends (TTFB) | ✓ first item after 5 ms (stream 1517 ms) |
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
| stream: first item before the stream ends (TTFB) | ✓ first item after 3 ms (stream 1512 ms) |
| cancellation reaches the backend | ✓ after 0 ms |
| full duplex over HTTP/2 (request stream, tier T1) | ✓ echoes arrived while the request was open |
| client stream as a whole (no duplex needed) | ✓ |
| WebSocket (tier T3) | ✓ full duplex |
| zstd response passes through | ✓ content-encoding: zstd |

## Findings

1. **Everything request/response-shaped works through a default nginx**, including the `QUERY`
   method (forwarded as-is), idempotency keys, ETags and zstd responses (passed through untouched).
2. **Streaming responses are not buffered** even with default `proxy_buffering on`, because apü
   sends `X-Accel-Buffering: no` on every stream (first item after 3–5 ms of a 1.5 s stream).
   `Incremental: ?1` (RFC 10036) is ignored by this nginx; the vendor header is what helps today.
3. **Cancellation propagates**: a client RST_STREAM makes nginx close the upstream connection and
   the handler's signal aborts immediately.
4. **Full duplex needs configuration**: with default `proxy_request_buffering on`, nginx waits for
   the complete request body before forwarding, so a bidi call that waits for answers deadlocks
   (the probe times out). Client streams that send everything first still work. Fix:
   `proxy_request_buffering off`. Request headers can't switch this off (`Incremental: ?1` is not
   honoured), so deployments must configure it — or use tier T3.
5. **WebSockets need the usual upgrade headers** (`proxy_set_header Upgrade/Connection`); nginx
   does not do RFC 8441 to clients, so Node's WebSocket client fell back to HTTP/1.1 Upgrade on its
   own and worked with the tuned config.

Recommended nginx location for apü: see `bench/proxy/nginx-tuned.conf`.
