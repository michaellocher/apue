# Richer docs, generated from the types only — research (2026-10-28)

Constraints (from you): no change to the API (op definitions, wire), no extra overhead, everything
generated from the existing type definitions — nothing hand-written. Follows research/07.
Prototypes ran in the scratchpad only; nothing here is implemented.

## Measured locally

- **The manifest is built once at server start** (`encodeJson(buildManifest(api))`) and served from
  memory with ETag/304: anything derived there costs nothing per request.
- **Generated examples** (one per input/output schema, rules as in Redocly's openapi-sampler: first
  enum value, `minimum` or 0, `"string"` padded/cut to the length bounds, one array item, first
  `anyOf` branch, bytes as `{"$upload": "…"}`), validated with the op's own schema: **73 of 74 valid**
  across 5 APIs / 37 ops. The failure: a regex `pattern` (`^[a-z]+\/\d+$`, flags `iu`) — patterns are
  the inherent limit. Rule therefore: an example that doesn't validate is omitted, never published.
- **Size/time**: manifest +24–32 % (e.g. 1.9 → 2.3 KB), build < 1 ms once at startup.
- **Codegen compatibility**: extra fields at op or top level → byte-identical generated client, and
  the round trip (API → manifest → code → manifest) still reproduces the original. `examples` *inside*
  a JSON Schema is rejected by codegen's keyword whitelist — so it would break existing generated
  clients' tooling: examples belong next to the schemas, never in them.
- **OpenAPI 3.2 document** derived from the definitions (GET with `?i=` as a `content` parameter,
  `query`, `post`, `Idempotency-Key`, problem responses): 9–19 KB raw (5–8× the manifest), **0.7–1.0 KB
  gzipped**, < 1 ms to build; can be built lazily on first request (zero cost if never requested).
  Not validated with an OAS 3.2 validator (none at hand; tool support for 3.2 unverified).

## Verified in the sources (OAS 3.2.0, JSON Schema 2020-12, tool sources)

- OAS 3.2 Schema Object "is a superset of the JSON Schema Specification Draft 2020-12" ✓; arbitrary
  keywords allowed (our `x-apue-*` fine). `query` is a Path Item field ("A definition of a QUERY
  operation") ✓. A JSON query parameter: "MUST include either a content field or a schema field, but
  not both", content map "MUST only contain one entry" ✓ — the spec's own example is JSON in a query
  parameter (our `?i=`).
- `itemSchema` is for sequential media types "without any sort of header, footer, envelope, or other
  metadata" ✓ — our length-prefixed frames don't qualify; `application/apue+json` stays opaque in
  OpenAPI (the per-message schema can only be given as an extension).
- OAS has no notion of RFC 9457 problem details (0 mentions ✓) — only a `default` response with
  `application/problem+json`.
- Neither OAS nor JSON Schema defines a marker for generated examples. `dataValue` "MUST be valid";
  JSON Schema `examples` "RECOMMENDED … valid".
- Example generators: openapi-sampler and Prism static mode ignore `pattern` (randexp only in
  json-schema-faker's random mode); none knows `x-apue-flags`.

## What is derivable from the definitions — and what is not

| derivable (no API change) | not derivable without changing `op()` |
|---|---|
| HTTP shape per op: methods, path, `?i=` rule, content types, `Idempotency-Key`, stream media type | errors a handler throws (`ApueError` from app code) |
| protocol errors per op from effect/stream/resumable/bytes/selection (400 validation, 405, 413, 415, 409/422 idempotency, 504, resume, upload, selection) | meaningful example values (only placeholders) |
| server limits (body, JSON depth, batch, selection, uploads) — from server options | strings for `pattern` constraints |
| placeholder examples, validated (omitted when invalid) | a machine-readable frame model in OpenAPI |

Risk to keep in check: a derived error list encodes rules that live in server code paths and could
drift — it would need a test (e.g. every error the fuzz tests provoke is in the op's list).

## Assessment against the constraints

- No API change: ✓ for all derived items (op-level/top-level fields only; verified compatible).
- No overhead: ✓ per request (prebuilt bytes, ETag); one-time < 1 ms; manifest +~30 % bytes; OpenAPI
  lazily → zero unless requested.
- From the types only: ✓ for HTTP shape, protocol errors, limits, placeholder examples; ✗ for
  domain errors, meaningful examples, pattern strings.
- Open: OpenAPI 3.2 validity with real tools; `application/openapi+json` is not IANA-registered
  (draft-ietf-httpapi-rest-api-mediatypes); whether placeholder examples help readers enough.
