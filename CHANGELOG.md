# Changelog

Versions follow [Semantic Versioning](https://semver.org/); tags have no `v` prefix (e.g.
`0.1.0-beta.1`). Pre-1.0 betas may change the wire format and APIs between releases; every change
is listed here.

## 0.1.0-beta.1 — 2026-10-28

First public beta of the apü toolkit (spec draft 01, see SPEC-DRAFT.md), `@michaellocher/apue`,
installed from this release's tarball (no registry, no token; README, "Install"). Website and docs:
https://michaellocher.github.io/apue/, where every protocol problem type
(`https://michaellocher.github.io/apue/problems/…`) has its page.

- **Protocol**: operations with declared effects on plain HTTP (GET with `?i=`, QUERY, POST,
  HEAD), RFC 9457 problems, idempotency keys, deadlines, field selection, ETag/304 and cache
  policies, an 8-byte frame format for streams with in-band END, heartbeats, resumable streams with
  stateless signed checkpoints, pipelined batches with references, binary values as BLOB frames.
- **Server** (`@michaellocher/apue/server`): HTTP/2 with HTTP/1.1 fallback, WebSocket tier with byte-window flow
  control, CORS, compression (zstd/br/gzip), manifest and RFC 9727 catalog with derived
  documentation, a `principal` hook for callers, bounded shutdown, resumable uploads
  (draft-ietf-httpbis-resumable-upload-14) with an optional file-backed and persistent store,
  `t.file()` streaming inputs, `t.download()` download resources with Range support, DPoP proof
  verification for the `principal` hook (`dpopVerifier`, RFC 9449).
- **Clients**: `ApueClient` with fetch, HTTP/2 (`@michaellocher/apue/http2`) and WebSocket (`@michaellocher/apue/websocket`)
  transports, retries, resume, uploads, downloads, batches, DPoP proofs (`createDpopSigner`).
- **Code generation** (`apue-types`, `@michaellocher/apue/codegen`): typed TypeScript modules and self-contained
  clients from a server's manifest — Python (standard library; resume, batches, compression,
  validation), Go (full duplex over HTTP/2), Java 17, and Swift (full duplex over HTTP/2 on Apple
  platforms, half duplex on Linux).
- **OpenAPI 3.2** at `/.well-known/openapi.json`, derived from the definitions (lazy, cached).
- **Production**: replicas (asynchronous shared idempotency stores, `instance`-prefixed upload and
  download ids with an `apue-replica` routing header, a verified nginx configuration), a `logger`
  option, bounded shutdown, and a deployment guide (docs/deployment.md).
