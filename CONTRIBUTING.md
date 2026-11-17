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

Run all of it before pushing: CI runs on Linux, and some browser behaviour differs there (S30). The
Swift client behaves differently on Linux too (S32); CI runs its test with `APUE_TEST_SYSTEM_CA=1`
(the test adds a throwaway certificate to the system trust store: root or passwordless sudo). To
run it locally in Docker, with Node 26 for Linux unpacked into `node-linux/`:

```sh
docker run --rm -e APUE_TEST_SYSTEM_CA=1 -v "$PWD:/repo:ro" -v "$PWD/node-linux:/opt/node:ro" -w /repo \
  swift:6.4.1-bookworm sh -c 'PATH=/opt/node/bin:$PATH node --test test/swift.test.ts'
```

## Releasing

Versions follow semver; tags have **no `v` prefix**. Betas are `0.1.0-beta.N`.

1. Update `version` in package.json and add a `## <version> — <date>` section at the top of
   CHANGELOG.md (the release notes are taken from it; a section still marked `unreleased` stops
   the release).
2. Commit (`Release <version>`), push `main`, wait for CI to pass. Optionally run the **Release**
   workflow by hand (Actions → Release → Run workflow, or `gh workflow run release.yml`): a dry
   run of the whole pipeline, publishing nothing.
3. Tag and push: `git tag -a <version> -m "<version>" && git push origin <version>`.
4. The **Release** workflow verifies that tag, package.json and changelog agree, runs the full
   checks, packs the tarball and creates a GitHub release with it (pre-releases marked as such),
   then installs the release's tarball from its download URL into a fresh project, the way the
   README tells users to. No registry and no secret: the workflow's own `GITHUB_TOKEN` creates the
   release. Bump the version in README's install URL too (`site/` takes it from package.json).

The website deploys from `main` through the **Pages**
workflow (Settings → Pages → Source: GitHub Actions). It is served at
https://michaellocher.github.io/apue/ (`ORIGIN` in site-src/build.mjs and check.mjs); the problem
type URIs in src/ are under that origin, so moving the site moves protocol identifiers.
