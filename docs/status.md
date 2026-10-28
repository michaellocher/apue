# Status — beta 0.1.0-beta.1 (2026-10-28)

## Ready

- **Toolkit** published as `@michaellocher/apue` (not yet released): server, TypeScript client
  (fetch, HTTP/2, WebSocket transports), code generators for TypeScript, Python, Go, Java and
  Swift, OpenAPI 3.2. The package is verified as users get it (`npm run verify:package`: packed,
  installed offline, every entry point, the CLI for every language, the README quick start).
- **Tests**: `npm test` — 404 tests: unit, integration, fuzz, chaos, leak, real browsers (Chrome,
  Firefox, WebKit), generated clients run against live servers in Python, Go, Java and Swift (macOS
  and, in CI, Linux). WebKit on Linux runs locally with `scripts/test-linux-webkit.sh`. Every fix
  has a test that fails without it (mutation-checked).
- **CI/CD** (GitHub Actions): CI on every push (Linux: typecheck, tests incl. browsers, site,
  package), Release on a version tag (GitHub Packages as `@michaellocher/apue`; GitHub release;
  run by hand it is a dry run of all of it), Pages (opt-in).
- **Production**: replicas (shared idempotency stores, instance routing verified through nginx),
  bounded shutdown, logging hook, DPoP proofs (verifier and signer), deployment guide
  ([deployment.md](deployment.md)).
- **Website**: `site/` (built from `site-src/`), with docs and a page per problem type.

## Before the first release (needs you)

1. License: MIT (confirmed). Register `apue.dev` (it was unregistered on 2026-10-28) before the
   website goes public: enable Pages (Source: GitHub Actions) and set `PAGES_ENABLED=true`.
2. Push the rewritten history to the reset repository (`git push -u origin main`).
3. Release: date the CHANGELOG entry, run the Release workflow by hand (dry run), then
   `git tag -a 0.1.0-beta.1 -m 0.1.0-beta.1 && git push origin 0.1.0-beta.1`. The package goes to
   GitHub Packages as `@michaellocher/apue` with the workflow's own token — no secret needed.

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
