# Richer API documentation at `/.well-known/apue` — research (2026-10-28)

Question: can the manifest document ops better, e.g. with example request/response bodies?
Research by a subagent (sources below); claims marked ✓ were re-checked by me against the source.

## Findings

**Carrying examples**
- JSON Schema 2020-12 `examples` (validation §9.5): an array, "no restrictions placed on the values";
  it is RECOMMENDED that they validate. An annotation per schema — it cannot pair an input with its output.
- OpenAPI 3.1.1: Schema Object `example` deprecated in favour of `examples`; on a Media Type Object
  `example`/`examples` are mutually exclusive; examples SHOULD match the schema.
- OpenAPI 3.2.0 §4.19: Example Object `dataValue` (MUST be valid against the schema) and
  `serializedValue` — including a worked case of JSON in a query parameter, i.e. our `?i=` ✓ (terms
  present in the spec text). 3.2 also has the `query` method and `itemSchema` for sequential media
  types (`text/event-stream`, JSON Lines, json-seq) ✓.
- AsyncAPI 3.x Message Example Object: `headers`/`payload` MUST validate.

**What comparable systems expose**
- gRPC server reflection: services, stream kinds, descriptors — no examples.
- Connect: GET encoding and its 5-byte envelope only in prose; no machine-readable frame description.
- GraphQL introspection: descriptions and deprecation (examples not found; only partly read).
- No standard describes a typed binary frame format like `application/apue+json` → examples should
  show the *decoded* frame sequence.

**Discovery and media types**
- RFC 9727 links via `service-desc` / `service-doc` / `service-meta` (RFC 8631); several
  `service-desc` targets are fine; no media type mandated.
- `application/openapi+json` is **not registered** at IANA ✓ (application registry checked
  2026-10-28; only `vnd.oai.workflows` (Arazzo) under OAI). It is defined in
  draft-ietf-httpapi-rest-api-mediatypes (with a `version` parameter), not yet an RFC.
- `application/asyncapi+json` is registered ✓; AsyncAPI's schema dialect is Draft-07-based (apü
  emits 2020-12).

## Recommendation (not implemented)

1. **Examples on the op**, not in the schema: `examples: [{ name, input, output } | { name, input,
   messages, end? } | { name, input, error: { status, type } }]` — pairs input with output, covers
   streams (decoded MSG/END sequence) and errors.
2. **Validated in `op()`** with the same schema code (parse + deep-equal, since parse strips unknown
   keys); optional doctest-style replay against the handler in tests.
3. **More manifest fields**: per op `errors` (status + problem type); top-level `limits` (body,
   JSON depth, batch, selection, uploads) and `http` (method mapping, `?i=` rule, headers, media types).
4. **Optionally generate OpenAPI 3.2** from the same definitions as a second `service-desc`
   (`application/openapi+json; version=3.2.0`, de facto until the media-type draft is an RFC), with an
   `x-apue-op` back-reference. No AsyncAPI for now (streams are HTTP request/response, dialect mismatch).
5. Caps on example size/count; examples are hand-written literals only (RFC 2606 domains), never
   captured traffic; document "consumers ignore unknown manifest fields".

Open: OAS 3.2 tool support for QUERY and JSON-in-query; how to show BLOB frames and `$upload`
references in examples; per-caller (auth-filtered) manifests vs one public cacheable manifest; a
manifest format version separate from the protocol version.

Sources: draft-bhutton-json-schema-validation-01; https://spec.openapis.org/oas/v3.1.1.html;
https://spec.openapis.org/oas/v3.2.0.html; AsyncAPI 3.1.0 spec; https://connectrpc.com/docs/protocol/;
grpc server-reflection.md; GraphQL spec (Oct 2021); RFC 9727; IANA media-types registry
(application.csv); https://datatracker.ietf.org/doc/draft-ietf-httpapi-rest-api-mediatypes/
