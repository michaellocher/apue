#!/bin/sh
# Runs the real-browser tests against WebKit on Linux (Playwright's build, as in CI) from macOS or
# anywhere with Docker: a Playwright WebKit server in a container, driven by test/browser.test.ts
# through WEBKIT_ENDPOINT. Chrome and Firefox run locally as usual. Needs Docker.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('playwright-core/package.json').version")
name="apue-webkit-$$"
port=3311
docker run -d --rm --name "$name" -p "127.0.0.1:$port:$port" -v "$PWD/node_modules/playwright-core:/pw:ro" \
  "mcr.microsoft.com/playwright:v$version-noble" node /pw/cli.js run-server --port "$port" --host 0.0.0.0 > /dev/null
trap 'docker rm -f "$name" > /dev/null 2>&1' EXIT
until docker logs "$name" 2>&1 | grep -q Listening; do sleep 0.5; done
WEBKIT_ENDPOINT="ws://127.0.0.1:$port/" node --test --test-timeout=120000 test/browser.test.ts
