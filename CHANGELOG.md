# Changelog

Versions follow [Semantic Versioning](https://semver.org/); tags have no `v` prefix (e.g.
`0.1.0-beta.1`). Pre-1.0 betas may change the wire format and APIs between releases; every change
is listed here.

## 0.1.0-beta.1 — unreleased

First public beta of the apü toolkit (spec draft 01, see SPEC-DRAFT.md).

- **Protocol**: operations with declared effects on plain HTTP (GET with `?i=`, QUERY, POST,
  HEAD), RFC 9457 problems, idempotency keys, deadlines, field selection, ETag/304 and cache
  policies, an 8-byte frame format for streams with in-band END, heartbeats, resumable streams with
  stateless signed checkpoints, pipelined batches with references, binary values as BLOB frames.
- **Server** (`apue/server`): HTTP/2 with HTTP/1.1 fallback, WebSocket tier with byte-window flow
  control, CORS, compression (zstd/br/gzip), manifest and RFC 9727 catalog with derived
  documentation, a `principal` hook for callers, bounded shutdown, resumable uploads
  (draft-ietf-httpbis-resumable-upload-14) with an optional file-backed and persistent store,
  `t.file()` streaming inputs, `t.download()` download resources with Range support.
- **Clients**: `ApueClient` with fetch, HTTP/2 (`apue/http2`) and WebSocket (`apue/websocket`)
  transports, retries, resume, uploads, downloads, batches.
- **Code generation** (`apue-types`, `apue/codegen`): typed TypeScript modules and self-contained
  Python clients from a server's manifest.
