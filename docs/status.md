# Status — beta 0.1.0-beta.1 (2026-10-28)

## Ready

- **Toolkit** published as `apue` (not yet released): server, TypeScript client (fetch, HTTP/2,
  WebSocket transports), code generators for TypeScript, Python, Go, Java and Swift, OpenAPI 3.2.
  The package is verified as users get it (`npm run verify:package`: packed, installed offline,
  every entry point, the CLI for every language, the README quick start).
- **Tests**: `npm test` — 395 tests: unit, integration, fuzz, chaos, leak, real browsers (Chrome,
  Firefox, WebKit), generated clients run against live servers in Python, Go, Java and Swift.
  WebKit on Linux runs locally with `scripts/test-linux-webkit.sh`. Every fix has a test that fails
  without it (mutation-checked).
- **CI/CD** (GitHub Actions): CI on every push (Linux: typecheck, tests incl. browsers, site,
  package), Release on a version tag (npm with provenance, GitHub release), Pages (opt-in).
- **Production**: replicas (shared idempotency stores, instance routing verified through nginx),
  bounded shutdown, logging hook, deployment guide ([deployment.md](deployment.md)).
- **Website**: `site/` (built from `site-src/`), with docs and a page per problem type.

## Before the first release (needs you)

1. Confirm the license (MIT is set) and register `apue.dev` (it was unregistered on 2026-10-28).
2. GitHub: an npm automation token as secret `NPM_TOKEN` in an environment `npm` (with a required
   reviewer); for the website, enable Pages (Source: GitHub Actions) and set `PAGES_ENABLED=true`.
3. Release: date the CHANGELOG entry, then `git tag -a 0.1.0-beta.1 -m 0.1.0-beta.1 && git push
   origin 0.1.0-beta.1` (CONTRIBUTING.md, "Releasing").

## Open (SPEC-DRAFT.md §13)

Everything else is decided: WebTransport/HTTP/3 are blocked by Node (no QUIC in the official
build); a full DPoP profile is deferred (groundwork in place); CBOR, CREDIT frames, per-frame
compression, `$map` and `Location` on QUERY were decided against with reasons. Known limits are
listed per feature in the spec (e.g. generated clients' duplex support, Swift on Linux untested).

## Where to start

[README.md](../README.md) · [SPEC-DRAFT.md](../SPEC-DRAFT.md) (design, spike log with every
measurement and bug) · [wire.md](wire.md) · [benchmarks.md](benchmarks.md) ·
[intermediaries.md](intermediaries.md) · [deployment.md](deployment.md).
