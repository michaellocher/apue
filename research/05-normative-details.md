# Verified normative details (checked 2026-10-28)

Verbatim checks against RFC / draft `.txt` files (rfc-editor.org, ietf.org archive), vendor docs and upstream source. **UNVERIFIED** marks what could not be confirmed from a primary source.

## RFC 10008 — QUERY (Proposed Standard, June 2026)
- **Accept-Query (§3)**: Structured Field **List** of media ranges (Tokens or Strings, no parameters inside the value; parameters as SF parameters). Applies to all URIs with the same path (query component ignored). Example: `Accept-Query: "application/jsonpath", application/sql;charset="UTF-8"`.
- **Content-Type (§2)**: "Servers MUST fail the request if the Content-Type request field … is missing or is inconsistent with the request content." Missing → 4xx (e.g. 400); unsupported → **415** (+ Accept-Query); inconsistent → 400; unprocessable query → 422; unsupported Accept → 406.
- **Content-Location (§2.3)** = GET-able URI for the *results just produced*; **Location (§2.4)** = GET-able URI that *repeats the query*.
- **Redirects (§2.5)**: 301/302/307/308 → re-send QUERY (no POST→GET rewrite); 303 → GET Location.
- **Conditional requests (§2.6)**: supported like GET (If-None-Match → 304).
- **Caching (§2.7)**: cacheable; cache key MUST incorporate request content and related metadata; caches MAY normalise semantically insignificant differences.
- **CORS (§4)**: not CORS-safelisted (Fetch: only GET, HEAD, POST). Fetch only upper-cases DELETE/GET/HEAD/OPTIONS/POST/PUT → always write `"QUERY"`.

## draft-ietf-httpapi-idempotency-key-header-08 (2026-10-22, still a draft)
- Item SF, value MUST be a **String** (`Idempotency-Key: "8e03…"`); UUID RECOMMENDED.
- Missing when required → SHOULD **400**; same key, different payload → SHOULD **422**; retry while original in progress → SHOULD **409**. Clients MUST correct requests before retrying, except 409.
- Fingerprint MAY be used (payload checksum etc.). Expiry SHOULD be documented; resources MUST publish an idempotency spec.
- Scoping (§5): composite key = client key + client-specific attributes known to the resource.
- **No replay-indicating response header is defined** (apü's `apue-replayed: ?1` is an extension).
- Go's `net/http` treats requests with `Idempotency-Key` (and QUERY) as replayable.

## RFC 9745 / RFC 8594
- `Deprecation`: Item SF, value MUST be an SF **Date** (`@1688169599`). `Link: <…>; rel="deprecation"`. Sunset MUST NOT be earlier than Deprecation (§4). Deprecation changes no behaviour.
- `Sunset`: HTTP-date (IMF-fixdate, `GMT`; RFC 9745's example with `UTC` is not valid IMF-fixdate). `rel="sunset"` link relation.

## RFC 9457 — Problem Details
- `type` absent ⇒ `about:blank`; then `title` SHOULD be the HTTP status phrase.
- `status` is advisory; generators MUST use the same code in the HTTP response.
- Extension names SHOULD start with a letter, use ALPHA/DIGIT/`_`, be ≥ 3 chars. Clients MUST ignore unknown extensions; members with the wrong type MUST be ignored.

## RFC 10036 — Incremental Forwarding (Proposed Standard, Aug 2026)
- `Incremental` Item SF, Boolean only (`?1` / `?0`), otherwise ignored. To stream both directions it MUST be set on **both request and response**.
- Refusal: 501 + `Proxy-Status: …; error=incremental_refused` (security) or 429 + `connection_limit_reached` (concurrency).

## QUERY support in intermediaries

| Component | Forwards | Caches | Source |
|---|---|---|---|
| AWS CloudFront | **No — 403 (invalid method)** | No | VERIFIED (AllowedMethods API, troubleshooting doc) |
| Akamai | No by default (non GET/HEAD/OPTIONS → **501**) | No | VERIFIED docs; QUERY-specific 501 inferred |
| Fastly VCL | Yes (`pass`) | No; forced lookup converts to GET and drops body | VERIFIED |
| Cloudflare | **UNVERIFIED** | No (non-GET not cached) | cache rule VERIFIED |
| AWS ALB | **UNVERIFIED** (only TRACE documented as rejected) | — | |
| nginx | Yes (any `A-Z_-` method) | No (`proxy_cache_methods GET HEAD POST`) | VERIFIED source |
| Envoy | Yes since **v1.40.0** (2026-10-13); before: HTTP/1 → **400 HPE_INVALID_METHOD** | No | VERIFIED |
| HAProxy | Yes (`HTTP_METH_OTHER`) | No; a 2xx/3xx QUERY **invalidates** the cached GET entry | VERIFIED source |
| Caddy | Yes (Go net/http) | — | inferred |
| Node.js llhttp | Yes since llhttp 9.2.0 (Node 21.7.2 / 22+) | — | VERIFIED; tested on 26.12.1 (h1 + h2) |
| Go net/http | Yes; `http.MethodQuery` on master 2026-08-27 | — | VERIFIED |

⇒ apü clients fall back from QUERY to POST on **400, 403, 405, 501**, and remember it only if POST then succeeds differently.

## CORS preflight cache caps (source-verified)
Chromium **7200 s** (`services/network/cors/preflight_result.cc`), Firefox **86400 s** (`nsCORSListenerProxy.cpp`; 0 or non-digits ⇒ not cached), WebKit **600 s** (`CrossOriginPreflightResultCache.cpp`). Default 5 s.
