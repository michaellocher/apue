# Problems of existing API styles — research catalogue (as of 2026-10-28)

Legend: **[V]** = verified against a primary/maintainer source; **[I]** = inference or common practitioner knowledge, not re-sourced.

## 1. Round trips, over-/under-fetching, N+1

**1.1 Dependent calls cost one network RTT each (waterfalls).** REST, JSON-RPC, gRPC, Connect, tRPC. GraphQL only fixes it for reads within one schema; Cap'n Proto / Cap'n Web fix it generally via *promise pipelining*. Kenton Varda's Cap'n Web post (2025-09-22): "solves the waterfall problem *without* introducing a new language"; calls GraphQL "awkward for chaining operations or mutations". https://blog.cloudflare.com/capnweb-javascript-rpc-library/ [V] · https://capnproto.org/rpc.html [V]. Severity: High on mobile/high-latency links; pipelining is almost absent from mainstream stacks [I].

**1.2 Server-side fetching moves N+1 to the server.** GraphQL (and federation adds cross-subgraph N+1). Bessey, "Why, after 6 years, I'm over GraphQL" (2024): clients can introduce N+1 by changing a query; authorization checks are N+1 too. https://bessey.dev/blog/2024/05/24/why-im-over-graphql/ [V] · https://wundergraph.com/blog/graphql-n-plus-1-problem [V]. Severity: High.

**1.3 Fixed resource shapes over-/under-fetch.** REST, gRPC. Partial conventions: JSON:API `fields[]`, OData `$select/$expand`, protobuf `FieldMask` [I]. Severity: Med.

## 2. HTTP caching and semantics lost

**2.1 Reads tunnelled through POST aren't CDN/browser cacheable.** GraphQL (GET only via persisted queries due to URL length), gRPC (POST-only), JSON-RPC, tRPC batches, SOAP. https://graphql.org/learn/performance [V]. Connect added GET only for `idempotency_level = NO_SIDE_EFFECTS`, opt-in. https://connectrpc.com/docs/go/get-requests-and-caching/ [V]. **RFC 10008 (HTTP QUERY method, Proposed Standard, 2026)** defines a safe, idempotent method with a body. https://rfc-editor.org/info/rfc10008 [V]. OpenAPI 3.2 (2025-09-23) can describe QUERY [V]. CDN/browser support for QUERY: unverified, likely immature [I]. Severity: High.

**2.2 Errors as HTTP 200 make status codes useless to infrastructure.** gRPC (status in trailers), GraphQL (`errors` array), JSON-RPC, SOAP faults. https://kmcd.dev/posts/grpc-web-should-have-fixed-grpc/ (2026-07-14) [V]. GraphQL-over-HTTP `application/graphql-response+json` still Stage 2 Draft, preparing release (2026-09-28). https://github.com/graphql/graphql-over-http [V]. Severity: High.

## 3. Error model and partial failure

**3.1 No portable error format.** RFC 9457 Problem Details, `google.rpc.Status` (https://google.aip.dev/193), GraphQL `errors[]`, JSON-RPC `error.code/data`, SOAP Fault. Clients can't write generic retry logic [I]. MCP had to renumber its JSON-RPC error codes in 2026-07-28. https://modelcontextprotocol.io/specification/2026-07-28/changelog [V]. Severity: High.

**3.2 GraphQL partial results conflate "error" with "absent".** Null propagation → everything nullable → lost type precision. Still open in 2026: graphql-spec PR #1163 "Error behaviors" (updated 2026-10-05), `@semanticNonNull` GAP-49. https://github.com/graphql/graphql-spec/pull/1163 [V]. REST/RPC have *no* partial-success model for batches [I]. Severity: High.

## 4. Versioning and schema evolution

**4.1 No agreed evolution strategy.** URL/header versioning; Stripe's date-pinned versions with a server-side compatibility layer https://stripe.com/blog/api-versioning [V]; GraphQL "versionless" + `@deprecated`. Deprecation (RFC 9745) / Sunset (RFC 8594) headers exist, low adoption [I]. Severity: High.

**4.2 Wire-format evolution traps.** Protobuf `required` "part of the root cause of many outages" https://buf.build/blog/totw-8-never-use-required [V]; field-number reuse corrupts data; proto3 implicit presence needed `optional` back. JSON: int64/decimal precision loss, no date type [I]. OpenAPI 4 "Moonwalk": "no planned end date" https://github.com/OAI/sig-moonwalk [V]. Severity: High.

## 5. Type safety, code generation, lock-in

**5.1 Codegen quality is poor/fragmented.** openapi-generator ~5,800 open issues+PRs (2026-10) [V]. TypeSpec 1.0 GA (2025) https://typespec.io/blog/typespec-1-0-GA-release/ [V], Smithy https://smithy.io [V] → multiple sources of truth [I]. Severity: Med-High.

**5.2 Language-locked type safety.** tRPC TS-only https://trpc.io/faq [V]; Cap'n Web JS/TS-centric [V]; Falcor dormant [V-ish]. Severity: Med.

**5.3 Vendor/license lock-in.** Apollo Federation/Router under Elastic License v2 https://www.apollographql.com/docs/resources/elastic-license-v2-faq/ [V]; gRPC-Web needs Envoy or translating proxy [V]. Severity: Med.

## 6. Browser compatibility and transports

**6.1 gRPC can't run natively in browsers.** Trailers + no JS control of h2 framing. gRPC-Web: unary + server-streaming only; bidi "pending on whatwg fetch/streams". https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md [V]. Fetch trailers API was *removed* (whatwg/fetch#772, Chromium WontFix) [V]; new PR #1940 (2026-07) to re-add `response.trailers` is explicitly non-mandatory [V]. Severity: High for any trailer-dependent protocol.

**6.2 Realtime is fragmented.** SSE: 6 connections/domain on HTTP/1.1, "Won't fix" https://developer.mozilla.org/en-US/docs/Web/API/EventSource [V]. WebSockets: no backpressure https://github.com/ricea/websocketstream-explainer [V]; can't authorize via headers/cookies easily (Varda) [V]; break L4 LB. GraphQL subscriptions: two incompatible WS protocols [V]. WebTransport reportedly Baseline since Safari 26.4 (2026), uneven implementations [V, secondary]. Severity: High — each style bolts on a separate realtime story with its own auth/errors/schema.

**6.3 Incremental delivery not standardized.** GraphQL `@defer/@stream` PR #742 closed unmerged (2025-06); #1110 still open (2026-10-19) [V]. Apollo Client supports multiple incompatible incremental formats [V]. OpenAPI 3.2 can describe SSE/JSON Lines/json-seq/multipart via `itemSchema` [V]. Severity: Med-High.

## 7. Infrastructure: load balancing, proxies, observability

**7.1 L4 LB breaks with long-lived h2 connections.** kube-proxy pins a connection to one pod. https://kubernetes.io/blog/2018/11/07/grpc-load-balancing-on-kubernetes-without-tears/ [V]. Severity: High in Kubernetes.

**7.2 Binary formats hurt debuggability.** grpcurl/reflection/descriptors needed [I]. But: LinkedIn measured up to 60% latency reduction for large payloads with protobuf vs JSON in Rest.li https://engineering.linkedin.com/blog/2023/linkedin-integrates-protocol-buffers-with-rest-li-for-improved-m [V]. Connect's JSON/protobuf dual-mode is the closest to "both" [I]. Severity: Med.

**7.3 Stateful sessions hurt scale-out.** MCP 2026-07-28 (current) *removed* `Mcp-Session-Id`, initialize handshake, SSE resumability (`Last-Event-ID`), and server-initiated requests (replaced by a retry-based multi-round-trip pattern). https://modelcontextprotocol.io/specification/2026-07-28/changelog [V]. Strong signal that statefulness and resumable streams conflict with commodity HTTP infra. Severity: High.

## 8. Security

**8.1 Query-language DoS.** Bessey: 128-byte introspection query tied up a public API for 10 s; ~2000× memory amplification on invalid queries; cost estimates off ~20× on lists [V]. IBM cost spec is de facto standard, implemented with deviations https://ibm.github.io/graphql-specs/cost-spec.html [V]. Severity: High.

**8.2 Per-field/per-object authorization.** OWASP API Top 10 2023 #1 is BOLA [I]. No API description language makes authZ declarable *and* enforceable [I]. Severity: High.

**8.3 CSRF via "simple" requests.** GraphQL multipart uploads / GET skip preflight → cross-site mutations. GHSA-2p3c-p3qw-69r4 (Apollo `csrfPrevention`) [V]. Severity: Med.

## 9. Operational patterns everyone reinvents

**9.1 Idempotency & retries.** IETF `Idempotency-Key` draft -00 (2021) → -07 (Oct 2025, expired Apr 2026), never an RFC. https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ [V]. Severity: High.

**9.2 Long-running operations.** Google AIP-151 Operation resource [V]; REST ad-hoc `202 + Location`; GraphQL nothing [I]; MCP "Tasks" added 2025-11-25, moved to extension 2026-07-28 with polling [V]. Severity: Med-High, growing with agents.

**9.3 Pagination.** Relay connections, RFC 8288 Link, AIP-158 page_token, JSON:API links, OData `$skiptoken` — none give consistent snapshots/total counts/change feeds [I]. Severity: Med.

**9.4 Binary uploads.** GraphQL needs third-party multipart spec or presigned URLs [V-ish]; gRPC ~4 MB default message limit [I]; base64 +33% [I]. IETF resumable uploads at draft-12 (July 2026), not RFC https://datatracker.ietf.org/doc/draft-ietf-httpbis-resumable-upload/ [V]. Severity: Med-High on mobile.

**9.5 Batching.** JSON-RPC batches: no ordering/partial-failure semantics beyond per-item errors [V]. GraphQL batching non-standard [I]. Cap'n Web batching only includes promises awaited before next I/O tick [V].

## 10. Discovery, introspection, AI agents

**10.1 Hypermedia failed in practice.** Fielding 2008 "REST APIs must be hypertext-driven" [V]; HAL/Siren/JSON-LD compete; clients hard-code URLs [I]. Newly relevant for agents [I].

**10.2 Introspection is both a risk and a necessity.** GraphQL introspection often disabled in prod; gRPC reflection optional; OpenAPI docs often stale [I].

**10.3 APIs aren't built for LLM agents.** Anthropic: ~77K tokens of tool definitions before work starts, cut 85% via tool search; accuracy 49%→74% https://www.anthropic.com/engineering/advanced-tool-use [V via summary]. "LLMs are better at writing code to call MCP than calling MCP directly" — Cloudflare Code Mode https://blog.cloudflare.com/code-mode/ [V]. Arazzo 1.0 workflows https://github.com/OAI/Arazzo-Specification [V]. MCP 2026-07-28 adds `ttlMs`/`cacheScope` cache hints and OTel trace propagation — reinventing HTTP caching/observability on JSON-RPC [V facts / I framing]. Severity: High and rising.

## 11. Legacy and others (brief)

SOAP/WS-*: heavy XML, POST-only, non-interoperable toolkits [I]. OData: powerful but a full query language with GraphQL-like DoS/authZ exposure [I]. JSON-RPC 2.0: no schema, no streaming, no HTTP binding → everyone (MCP, LSP, Ethereum) adds a layer [V spec / I rest]. AsyncAPI 3.0 added request/reply → sync and async description still split across two specs [V secondary].

## Top 10 unsolved / poorly-solved problems (ranked)

1. **No unified sync + streaming + realtime model across browser and backend.** (6.1–6.3, 7.3)
2. **Expressive *and* cacheable reads.** QUERY (RFC 10008) is new and undeployed; Connect GET is opt-in. (2.1)
3. **No portable error + partial-failure model** incl. retryability and per-field errors, visible to HTTP infra. (2.2, 3.1, 3.2)
4. **Schema evolution/versioning without compat layers or outages.** (4.1, 4.2)
5. **Round-trip latency for dependent calls without a server-side query language** — pipelining exists only in niche stacks. (1.1, 1.2)
6. **Query cost / DoS / fine-grained authZ**, not declarable in the contract. (8.1, 8.2)
7. **Idempotency, retries, long-running operations** unstandardized. (9.1, 9.2)
8. **Agent-consumable APIs**: compact discovery, workflows, typed code-callable surfaces, session-less state. (10.3, 7.3)
9. **Infrastructure compatibility**: LB/stickiness, proxies, debuggability vs. binary efficiency. (7.1, 7.2)
10. **Large/resumable binary transfer on flaky networks.** (9.4)

Honourable mentions: pagination consistency (9.3), toolchain/license lock-in (5.1–5.3).

## Verification notes

Verified this session: RFC 10008 status; GraphQL-over-HTTP status; graphql-spec PRs #742/#1110/#1163; whatwg/fetch #772/#1940; MCP 2026-07-28 changelog; Cap'n Web & Code Mode posts; Bessey post; Connect GET docs; gRPC PROTOCOL-WEB; MDN SSE limit; Buf on `required`; OpenAPI 3.2 & Moonwalk; IETF idempotency & resumable-upload drafts; Apollo ELv2 & CSRF advisory; LinkedIn protobuf numbers; TypeSpec 1.0; k8s gRPC LB post; Stripe versioning.

Verified only via search summaries: Anthropic tool-search figures; WebTransport Baseline/Safari 26.4; Arazzo 1.1; AsyncAPI 3 request/reply; Netflix federation talk.

Inference / not re-sourced: SOAP & OData critiques; gRPC 4 MB limit; base64 overhead; JSON int64 precision; Deprecation/Sunset adoption; OWASP BOLA URL; GitHub/Shopify rate limits; composite-schemas status; QUERY CDN/browser support; all severity ratings and the ranking.
