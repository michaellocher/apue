# Contributing

Thanks for helping. apü is in beta: the spec ([SPEC-DRAFT.md](SPEC-DRAFT.md)) and the toolkit evolve
together, and every change is measured or tested before it lands.

## Ground rules

- **Research first, no assumptions.** Claims about protocols, browsers or proxies cite their source
  or a measurement; performance changes come with numbers (`node bench/run.ts`, `docs/benchmarks.md`).
- **Every fix has a regression test that fails without the fix.** Check it: break the fix, watch the
  test fail, restore it.
- **The spec is part of the change.** Behaviour changes update SPEC-DRAFT.md (the section and the
  spike log in §15) and, if user-visible, CHANGELOG.md and the website (`site-src/`, then
  `npm run site`).
- Code style: match the surrounding code — comments explain *why*, names are plain words.

## Workflow

One `main` branch; work happens in feature branches merged into `main` (linear history). Commits
are self-contained with a message that explains the reasoning.

```sh
npm install
npm run typecheck && npm test   # what CI runs, plus:
npm run build && npm run verify:package && npm run site
scripts/test-linux-webkit.sh    # the browser tests in WebKit on Linux (Docker), as CI runs them
```

Run all of it before pushing: CI runs on Linux, and some browser behaviour differs there (S30).

## Releasing

Versions follow semver; tags have **no `v` prefix**. Betas are `0.1.0-beta.N`.

1. Update `version` in package.json and add a `## <version> — <date>` section at the top of
   CHANGELOG.md (the release notes are taken from it).
2. Commit (`Release <version>`), push `main`, wait for CI to pass.
3. Tag and push: `git tag -a <version> -m "<version>" && git push origin <version>`.
4. The **Release** workflow verifies that tag, package.json and changelog agree, runs the full
   checks, publishes to npm with provenance (pre-releases under the `beta` dist-tag, so
   `npm install apue` keeps getting the latest stable) and creates a GitHub release with the
   tarball.

One-time setup: an npm automation token as the repository secret `NPM_TOKEN` (Settings → Secrets
and variables → Actions), in an environment named `npm` (Settings → Environments) — require a
reviewer there to approve each publish. The website deploys from `main` through the **Pages**
workflow once enabled — publishing makes it public, so it is opt-in: Settings → Pages → Source:
GitHub Actions, then the repository variable `PAGES_ENABLED=true`; add `site/CNAME` with `apue.dev`
once the domain points to GitHub Pages.
