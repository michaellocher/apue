// Renders og.html to site/assets/og.png (1200×630) with headless Chrome via playwright-core (a
// devDependency). Run by hand when the card changes: `node site-src/og.mjs [path/to/chrome]`.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = import.meta.dirname;
const chrome = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'apue-og-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chrome,
  headless: true,
  viewport: { width: 1200, height: 630 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(pathToFileURL(join(HERE, 'og.html')).href);
  await page.screenshot({ path: join(HERE, '..', 'site', 'assets', 'og.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log('wrote site/assets/og.png');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
