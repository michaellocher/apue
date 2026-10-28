# Resumable uploads — research for apü (2026-10-28)

Sources, checked on 2026-10-28:
- draft-ietf-httpbis-resumable-upload-14 (datatracker: active WG document, last updated 2026-10-18,
  intended status Proposed Standard; **not an RFC yet**), https://www.ietf.org/archive/id/draft-ietf-httpbis-resumable-upload-14.html
- Node 26.12.1 behaviour measured locally (below).

## The protocol (draft-14), as needed here

- **Upload creation** (§6): any request with content (POST/PUT/PATCH) to the *target resource*, with
  `Upload-Complete` (SF Boolean, `?1` = the content is the entire representation) and, when known,
  `Upload-Length` (SF Integer). The server SHOULD send `104 (Upload Resumption Supported)` with
  `Location` (the *upload resource*) and `Upload-Limit`. With `Upload-Complete: ?0` and processed
  content the final response MUST carry `Location` (and `Upload-Limit`); 201 RECOMMENDED.
  An **empty** creation request with `?0` is valid and "can be used to retrieve the upload resource's
  URI before transferring any representation data" (§6.1, "careful upload creation" §17.2).
- **Offset retrieval** (§7): `HEAD` (RECOMMENDED) on the upload resource; 2xx MUST carry
  `Upload-Offset` (and `Upload-Limit`), SHOULD carry `Cache-Control: no-store`. Clients MUST NOT
  retrieve the offset while a request to the same upload is in progress.
- **Append** (§8): `PATCH` with `Content-Type: application/partial-upload`, `Upload-Offset` and
  `Upload-Complete` (both MUST). Offset mismatch: MUST reject with 409, `Upload-Complete: ?0` and the
  correct `Upload-Offset`; problem type `…#mismatching-upload-offset` with `expected-offset` /
  `provided-offset`. When the upload completes, the server SHOULD answer with what the *target
  resource* of the creation request would have produced, with `Upload-Complete: ?1`. A server MAY
  replay that final response for a valid append to a completed upload.
- **Cancellation** (§9): `DELETE` on the upload resource; the server SHOULD deactivate it and
  terminate in-flight requests to it; example response 204.
- **Upload-Limit** (§5, SF Dictionary): `max-size`, `min-size`, `max-append-size`,
  `min-append-size`, `max-age` (seconds); unknown keys ignored. An `OPTIONS` response with the
  header signals support even without limits (`min-size=0` then).
- **Lengths** (§4.3): `Upload-Length` and a `Content-Length`-derived length MUST match and stay
  consistent; problem type `…#inconsistent-upload-length` (400). Appends past a known length are
  rejected and the upload deactivated (§8.2).
- **Response semantics of `Upload-Complete`** (§4.2.1): `?1` means the target resource's semantics
  apply (a 4xx/5xx then can't be fixed by resuming); `?0` means the resumable-upload semantics apply.
- **Draft interop** (Appendix B): interop version **10**. Draft clients MUST send
  `Upload-Draft-Interop-Version: 10`; draft servers send it with 104 and MUST NOT send 104 when it is
  missing or different.
- **Security** (§20.1): only authorized clients may access the upload resource; upload URIs
  RECOMMENDED hard to guess and MUST NOT embed information not meant to be exposed.

## Facts about the platform (measured)

- `node:http2` can send a 104 interim response (`stream.additionalHeaders({ ':status': 104, … })`)
  and a node:http2 client sees it as a `'headers'` event — verified with a two-process check.
- Node's HTTP/1.1 server API has no generic 1xx (only 100, 102, 103 helpers): no 104 over HTTP/1.1.
- `fetch` never exposes 1xx responses, so browsers cannot learn `Location` from a 104 → the apü
  client uses the empty "careful" creation (one extra round trip) and works everywhere.

## Fit with apü

The draft's target resource is "a resource that accepts content". apü adds one: `POST /$uploads`,
whose final response is a reference `{ "upload": "<id>", "size": n }`. Op inputs may then carry
`{ "$upload": "<id>" }` exactly where the schema says `t.bytes()`: the server resolves it (same
credentials scope) before validation. This gives

- binary inputs for **unary** ops (refused before: a URL or JSON body cannot carry bytes),
- uploads that survive connection loss and work through every proxy (plain HTTP requests),
- interop with clients implementing the draft (e.g. URLSession) for the upload itself.

Upload ids are 128-bit random (base64url) and scoped like idempotency keys (hash of
`Authorization`), so a guessed or leaked id from another principal resolves to 404/400.
