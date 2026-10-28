# Callers and credentials across tiers — research and decision (2026-10-28)

Question (spec §13 item 6): out of scope (standard `Authorization`), or define more? Research by a
subagent with primary sources; claims marked ✓ were checked in the source text; *inference* marks
reasoning. Decision by you: option 2 below. Implemented as S21.

## What was wrong

- **T3 dropped the credentials.** `webSocketTransport` turned only the deadline into a query
  parameter; `Authorization` set on a call never reached the server, so browser request streams over
  WebSocket ran anonymously (scope of the empty header). The research also listed `Idempotency-Key`
  as dropped — checked in the code: irrelevant, keys apply only to calls without a request stream,
  and resumable ops are server streams; neither ever travels over T3.
- **Cross-site WebSocket hijacking with `cors.origins: '*'`.** The handshake accepted any Origin and
  handlers saw the browser's cookies — any site could call a cookie-authenticated API as its user.
- **Scopes keyed by the raw credential.** Idempotency keys and uploads were scoped by a hash of the
  `Authorization` header: a token refresh (401 → refresh → retry) lands in a new scope (the retry
  executes again; an upload in progress becomes 404); cookie-only apps (no `Authorization`) put all
  users in one scope (*inference* from the code).

## Findings

- Browser WebSockets: the page sets only URL and subprotocols; the browser fixes all handshake
  headers ✓ (WHATWG WebSockets, establish a WebSocket connection). The handshake has credentials mode
  "include" and referrer "no-referrer" ✓; mode "websocket" sets response tainting to "basic" — no
  CORS ✓ (Fetch, main fetch); `Origin` is always sent ✓. RFC 6455 §10.2: Origin protects browsers
  only, "The intent is not to prevent non-browsers from establishing connections" ✓; §10.5 prescribes
  no authentication method ✓.
- Subprotocol values are tokens (`1#token`) ✓ — base64url without padding fits.
- Production patterns: cookies + Origin allowlist (OWASP WebSocket cheat sheet: "Validate the
  Origin header on every handshake", explicit allowlist ✓); tokens in the query (RFC 6750 §2.3:
  "SHOULD NOT be used unless it is impossible to transport the access token in the Authorization
  request header" ✓ — URLs end up in logs); **token as a subprotocol** — Kubernetes
  `base64url.bearer.authorization.k8s.io.<base64url>`, requires another subprotocol to echo and
  strips the token after authenticating ✓ (`apiserver/pkg/authentication/request/websocket/
  protocol.go`); first-message authentication (OWASP ✓) — leaves the handshake unauthenticated and
  would add a message type to apü's unchanged frame stream (*inference*).
- `Authorization` is a CORS non-wildcard request header: `Access-Control-Allow-Headers: *` does not
  cover it ✓ (Fetch).
- DPoP (RFC 9449) binds tokens to a key; one signed proof per request, `jti` replay cache, optional
  nonce round trips ✓. It does not work for browser WebSockets as specified (the page can't set the
  `DPoP` header; *inference*). Token Binding never shipped in Chrome (intent to remove, 2018).
  Chrome's DBSC binds cookie sessions to a device without per-request changes ✓; whether it covers
  WebSockets: not verified.
- Stripe scopes idempotency keys to the account ✓; tus and the resumable-upload draft leave
  authorization to the server ("SHOULD ensure that only authorized clients can access the upload
  resource", draft-14 §20.1 ✓).

## Decision and design (option 2: a principal hook + credentials as a subprotocol on T3)

- **`principal(request) → string | undefined`** (server option, may be async): a stable identity
  (user/account id, not the credential). Scopes idempotency keys, uploads (visibility and quota) and
  resume tokens; handlers get `ctx.principal`. An `ApueError` it throws (401) is the response. Called
  once per op, batch or upload request — not for the manifest, preflights or `fallback`; without an
  async hook there is no extra await on the request path.
- **Without the hook** nothing changes for existing servers: scopes stay the raw `Authorization`,
  resume tokens stay unbound (binding them to a raw token would break every resume after a
  refresh), upload quotas count per address (an unverified header must not buy a fresh quota).
- **Resume tokens are bound to the principal** (with the hook): a stream's identity includes who is
  asking — the same input can mean different data for different users (a per-user feed).
- **T3:** the client offers `apue.v1, apue.auth.<base64url(Authorization)>`; the server selects
  only `apue.v1` (never echoes the token), hands the value to the call as `authorization`, and
  removes the carrying subprotocol from the headers handlers (and their logs) see. Strict parsing:
  canonical base64url without padding of a valid field value (visible ASCII, inner spaces/tabs),
  at most one, never next to an `Authorization` header → else the handshake is 400. The client
  refuses values that can't travel (non-ASCII) before connecting.
- **CSWSH:** a cross-origin handshake (Origin ≠ the server's origin) gets ambient credentials —
  `Cookie` and cached HTTP `Authorization` — only if CORS allows credentials (an explicit origin
  list with `credentials: true`), exactly the rule fetch follows. With `'*'`, cookies never reach a
  cross-origin call; credentials the page offers explicitly (the subprotocol) still work.
  Same-origin and non-browser (no Origin) handshakes are unaffected.
- `uploads.clientKey` (S19) is gone: the principal is that key now.

## Not done / open

- DPoP profile (option 3) — deferred: one signature per call and a replay cache, while DBSC covers
  cookie apps transparently.
- Cross-site WebSockets under third-party-cookie partitioning: not verified (with the rule above,
  cross-site cookie auth needs `credentials: true` anyway).
- Proxies may log `Sec-WebSocket-Protocol` like any header (the token travels like `Authorization`,
  which they may log as well); tokens should be short-lived (RFC 6750 §5.3: one hour or less in
  browsers).
- ~~A failed handshake reaches the browser only as a failed connection~~ → S23: unusable
  credentials are answered in-band (400 END frame with the reason); a token the principal hook
  rejects is its 401, also in-band. Only Origin, version and subprotocol failures refuse the
  handshake.
