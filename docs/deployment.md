# Deploying apü

What a production deployment needs, with the settings that matter. The template server is
[`examples/production/server.ts`](../examples/production/server.ts) (typechecked with the repo);
the load-balancer configuration [`docs/deployment/nginx.conf`](deployment/nginx.conf) is verified
end to end by `node scripts/verify-deployment.ts` (needs Docker).

## Runtime

- **Node ≥ 26.11** (`npm install @michaellocher/apue`; the package ships JavaScript, no type stripping needed).
- **TLS is required**: the server speaks HTTP/2 over TLS with HTTP/1.1 fallback (`key`, `cert`).
  Terminating TLS at a proxy is fine; the proxy then talks to the replica over TLS as well.
- One process per CPU core is the usual layout; the server is single-threaded like any Node server.

## Behind a proxy or load balancer

- **Streaming**: turn request and response buffering off (`proxy_request_buffering off`,
  `proxy_buffering off` in nginx) so client streams, uploads, frames and SSE flow without delay,
  and allow long reads (`proxy_read_timeout`; apü sends heartbeats every 15 s by default).
- **WebSockets** (tier T3, browsers' streaming uploads where fetch can't): forward `Upgrade` /
  `Connection`, or HTTP/2 extended CONNECT where the proxy supports it.
- Measured behaviour through nginx, Caddy, HAProxy and Envoy: [intermediaries.md](intermediaries.md).

## Several replicas

Most of apü is stateless; four things are not, and each has a setting:

| State | Setting | Why |
|---|---|---|
| Resume tokens | `resume: { secret }`, the same on every replica | a stream resumes on whichever replica the reconnect reaches |
| Idempotency keys | `idempotency`: a store over shared storage (the contract allows promises) | a retry that reaches another replica is replayed, not run twice |
| Uploads | `instance` per replica, and route by it (below) | an upload's content lives on the replica that received it |
| Download resources (`t.download()`) | the same `instance` routing | a download URL is served by the replica that created it |

**Routing by replica**: with `instance: 'eu-1'`, upload and download ids are `eu-1.<random>`.
Route `/$uploads/eu-1.…` and `/$downloads/eu-1.…` by path, and calls that reference uploads by the
`apue-replica` header that `ApueClient` sends — see [deployment/nginx.conf](deployment/nginx.conf).
Verified: 30 of 30 calls with automatic uploads and downloads succeed through nginx across two
replicas; with plain round robin, 0 of 30 do. Clients that don't send the header (other generated
clients) still work behind connection-affine balancing (L4, or HTTP/2 connections pinned to a
replica), because an upload and the call that uses it travel on the same connection.

Persistent uploads (`uploads.persistent`) survive a restart of the same replica; give every replica
its own `uploads.directory` (a lock refuses a second process).

## Callers, limits, security

- **`principal`**: name the caller (a user id) from your authentication. Quotas, idempotency keys,
  uploads and resume tokens are scoped to it; without it, upload quotas count per client address —
  behind a proxy that is the proxy's address for everyone.
- **CORS**: list origins explicitly; `credentials: true` only with a list. Cross-origin WebSocket
  handshakes lose cookies unless CORS allows credentials (cross-site WebSocket hijacking).
- **Limits** (defaults in parentheses): `maxBodyBytes` (1 MiB, JSON bodies), `maxJsonDepth` (64),
  `maxBatchCalls` (64), `maxConcurrentStreams` (256), `idleTimeoutMs` (120 s), `bodyTimeoutMs`
  (30 s), `uploads.maxBytes` / `storeBytes` / `scopeBytes` / `scopeUploads`, `downloads.ttlMs`.
- The manifest (`/.well-known/apue`) and the OpenAPI document (`/.well-known/openapi.json`) are
  public by design; set `openapi: false` to drop the latter.

## Shutdown, health, logging

- On `SIGTERM` call `server.close()`: it stops accepting, lets calls finish for `shutdownGraceMs`
  (10 s by default), then ends the rest with a retryable 503 — clients retry or resume elsewhere.
  Keep the grace period below the orchestrator's (Kubernetes: 30 s).
- Health checks: answer a path such as `/healthz` in the `fallback` hook.
- `logger: { error(message, detail) }` receives server-side failures (handler errors, output that
  doesn't match its schema, an idempotency store failing to record); client mistakes and
  disconnects are not logged.
