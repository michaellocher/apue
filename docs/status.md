# Status — beta 0.1.0-beta.1 (2026-11-18)

## Ready

- **Toolkit** `@michaellocher/apue`, released on GitHub (install by URL, README "Install"):
  server, TypeScript client (fetch, HTTP/2, WebSocket transports), code generators for
  TypeScript, Python, Go, Java and Swift, OpenAPI 3.2. The package is verified as users get it (`npm run verify:package`: packed,
  installed offline, every entry point, the CLI for every language, the README quick start).
- **Tests**: `npm test` — 404 tests: unit, integration, fuzz, chaos, leak, real browsers (Chrome,
  Firefox, WebKit), generated clients run against live servers in Python, Go, Java and Swift (macOS
  and, in CI, Linux). WebKit on Linux runs locally with `scripts/test-linux-webkit.sh`. Every fix
  has a test that fails without it (mutation-checked).
- **CI/CD** (GitHub Actions): CI on every push (Linux: typecheck, tests incl. browsers, site,
  package), Release on a version tag (GitHub release with the tarball, then installed from its URL
  as users do; run by hand it is a dry run), Pages (https://michaellocher.github.io/apue/).
- **Production**: replicas (shared idempotency stores, instance routing verified through nginx),
  bounded shutdown, logging hook, DPoP proofs (verifier and signer), deployment guide
  ([deployment.md](deployment.md)).
- **Website**: https://michaellocher.github.io/apue/ (`site/`, built from `site-src/`), with docs and
  a page per problem type.

## Releases

MIT licensed; the repository is public. Each release is a tag (no `v` prefix) that the Release
workflow turns into a GitHub release with the package tarball, then installs from its URL as users
do — no registry, no secret (CONTRIBUTING.md, "Releasing").

## Open (SPEC-DRAFT.md §13)

Everything else is done or decided: WebTransport/HTTP/3 are blocked by Node (no QUIC in the
official build; apü works behind an HTTP/3-terminating proxy); CBOR, CREDIT frames, per-frame
compression, `$map` and `Location` on QUERY were decided against with reasons. Known limits are
listed per feature in the spec (e.g. generated clients' duplex support: Swift on Linux is half
duplex, FoundationNetworking can't pause a request body).

## Where to start

[README.md](../README.md) · [SPEC-DRAFT.md](../SPEC-DRAFT.md) (design, spike log with every
measurement and bug) · [wire.md](wire.md) · [benchmarks.md](benchmarks.md) ·
[intermediaries.md](intermediaries.md) · [deployment.md](deployment.md).
