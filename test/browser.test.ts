// S5: runs test/browser/suite.ts inside real browsers — headless Chrome (CDP) and Firefox
// (WebDriver BiDi) — against an apü server on a different origin (CORS). The page and the
// src/*.ts modules are served type-stripped by node:module, so there is no build step here either.
// Browsers that aren't installed are skipped.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import { stripTypeScriptTypes } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ApueError } from '../src/protocol.ts';
import type { Handlers } from '../src/server.ts';
import { browserApi } from './browser/api.ts';
import type { CheckResult } from './browser/suite.ts';
import { download } from '../src/downloads.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// WebKit (Safari's engine) via Playwright's build — Safari itself needs `sudo safaridriver --enable`.
const WEBKIT = await (async () => {
  try {
    const { webkit } = await import('playwright-core');
    return webkit.executablePath();
  } catch {
    return '/nonexistent/playwright-webkit';
  }
})();
const FIREFOX = process.env.FIREFOX_PATH ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const ROOT = resolve(import.meta.dirname, '..');

const EXPORT = new Uint8Array(1024 * 1024).map((_, i) => (i * 7) % 251);
let cancelledStreams = 0;
let flooded = 0;
const FLOOD_ITEM = 'x'.repeat(64 * 1024);
let lastDuplexVersion = '';
let nextOrder = 1;
const handlers: Handlers<typeof browserApi> = {
  'users.get': ({ id }) => ({ id, name: `user ${id}` }),
  'users.search': ({ q, tags }) => ({ q, count: tags.length }),
  'orders.create': () => ({ orderId: nextOrder++ }),
  'count.up': async function* ({ to }) {
    for (let i = 1; i <= to; i++) yield i;
  },
  'ticker': async function* (_input, ctx) {
    ctx.signal.addEventListener('abort', () => cancelledStreams++);
    for (let i = 0; ; i++) {
      yield i;
      await sleep(5);
    }
  },
  'stats.cancelled': () => cancelledStreams,
  'slow.get': async () => {
    await sleep(2_000);
    return 'late';
  },
  'big.get': () => 'x'.repeat(8192),
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'stats.lastDuplexVersion': () => lastDuplexVersion,
  'flood': async function* (inputs) {
    flooded = 0;
    for await (const _ of inputs) break;
    for (let i = 0; i < 500; i++) {
      flooded++;
      yield FLOOD_ITEM;
    }
  },
  'stats.flooded': () => flooded,
  'files.store': ({ data }) => ({ size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }),
  'files.ingest': async ({ file }) => {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.stream()) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    return { size, sha256: hash.digest('hex'), declared: file.sha256 };
  },
  'export.archive': ({ corrupt }) => {
    const archive = download.fromBytes(EXPORT, { type: 'application/zip', filename: 'export.zip' });
    // corrupt: announces another digest — the client must refuse the content
    return { archive: corrupt ? { ...archive, sha256: '0'.repeat(64) } : archive };
  },
  'who.am': (_, ctx) => ({ principal: ctx.principal ?? null, authorization: (ctx.headers.authorization as string | undefined) ?? null, protocols: null }),
  'who.streaming': async (inputs, ctx) => {
    for await (const _ of inputs);
    return { principal: ctx.principal ?? null, authorization: (ctx.headers.authorization as string | undefined) ?? null, protocols: (ctx.headers['sec-websocket-protocol'] as string | undefined) ?? null };
  },
  'echo.duplex': async function* (inputs, ctx) {
    lastDuplexVersion = `HTTP/${ctx.httpVersion}`;
    for await (const value of inputs) yield { echo: value };
  },
};

let page: { url: string; close(): Promise<void> };
let api: { url: string; close(): Promise<void> };

before(async () => {
  page = await startPageServer();
  api = await startServer(browserApi, handlers, {
    cors: { origins: [page.url], credentials: true },
    uploads: {},
    // "Bearer <user>" names the user (S21): checks that the principal reaches handlers on every tier.
    principal: ({ headers }) => (typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ') ? headers.authorization.slice(7) : undefined),
  });
});
after(async () => {
  await api?.close();
  await page?.close();
});

describe('in real browsers', () => {
  for (const [name, binary, drive] of [
    ['Chrome (headless, CDP)', CHROME, runInChrome],
    ['Firefox (headless, WebDriver BiDi)', FIREFOX, runInFirefox],
    ['WebKit (headless, Playwright)', WEBKIT, runInWebKit],
  ] as const) {
    // Generous: a busy CI runner can take most of a minute to start a browser (see bidiEndpoint).
    test(name, { skip: existsSync(binary) || (binary === WEBKIT && process.env.WEBKIT_ENDPOINT) ? false : `${binary} not installed`, timeout: 180_000 }, async (t) => {
      const results = (await drive(binary, `${page.url}/`, "typeof window.__run === 'function'", `window.__run(${JSON.stringify(api.url)}).then(JSON.stringify)`)) as CheckResult[];
      for (const r of results) t.diagnostic(`${r.ok ? (r.skipped ? 'SKIP' : 'ok  ') : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      const failed = results.filter((r) => !r.ok);
      assert.deepEqual(failed, [], `${name}: ${failed.map((f) => `${f.name}: ${f.detail}`).join('; ')}`);
      assert.ok(results.length >= 14, `only ${results.length} checks ran`);
    });
  }
});

void ApueError;

describe('examples/todo in real browsers (same-origin app + API)', () => {
  let example: { url: string; stop(): void } | undefined;
  before(async () => {
    const { spawn } = await import('node:child_process');
    const { createInterface } = await import('node:readline');
    const child = spawn(process.execPath, [join(ROOT, 'examples/todo/server.ts')], { env: { ...process.env, PORT: '0', APUE_DEBUG_STREAMS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`example server exited with ${code}`)));
    });
    example = { url: `https://localhost:${/localhost:(\d+)/.exec(line)![1]}`, stop: () => child.kill() };
  });
  after(() => example?.stop());

  // Drives the page like a user: add a todo through the form, import 100 via a client stream,
  // and wait for the live change stream to render all of them. Ready means the app's submit handler is
  // installed: a requestSubmit() before that submits the form natively and navigates (seen once in
  // Chrome as "Inspected target navigated or closed").
  const script = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rendered = () => document.querySelectorAll('#list li').length;
    const until = async (fn, tries = 250) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(20); } return false; };
    // Counted on the server, not in the list: the change stream replays earlier browsers' todos for
    // a while after the page is ready, and counting the list mid-replay was off (102 in Firefox
    // locally, 109 in WebKit on a slower CI machine).
    const serverCount = async () => (await (await fetch('/todos.list', { cache: 'no-store' })).json()).length;
    const before = await serverCount();
    const form = document.querySelector('#add');
    form.title.value = 'from the browser';
    form.requestSubmit();
    const added = await until(async () => (await serverCount()) >= before + 1);
    document.querySelector('#import').click();
    const imported = await until(() => document.querySelector('#log').textContent.includes('imported 100'));
    const after = await serverCount();
    // …and the live stream shows every todo the server has.
    const shown = await until(() => rendered() === after, 750);
    return JSON.stringify({ added, imported, count: after - before, shown, rendered: rendered(), server: after, log: document.querySelector('#log').textContent.split('\\n')[0] });
  })()`;

  for (const [name, binary, drive] of [
    ['Chrome', CHROME, runInChrome],
    ['Firefox', FIREFOX, runInFirefox],
    ['WebKit', WEBKIT, runInWebKit],
  ] as const) {
    test(name, { skip: existsSync(binary) || (binary === WEBKIT && process.env.WEBKIT_ENDPOINT) ? false : `${binary} not installed`, timeout: 120_000 }, async (t) => {
      const result = (await drive(binary, `${example!.url}/`, "document.readyState === 'complete' && document.querySelector('#add')?.onsubmit != null", script)) as { added: boolean; imported: boolean; count: number; shown: boolean; log: string };
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.added, true);
      assert.equal(result.imported, true);
      assert.equal(result.count, 101);
      assert.equal(result.shown, true, `the page renders every todo the server has (${JSON.stringify(result)})`);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Page server: index.html plus type-stripped .ts modules from src/ and test/browser/.

async function startPageServer(): Promise<{ url: string; close(): Promise<void> }> {
  const { key, cert } = testCert();
  const server = http2.createSecureServer({ key, cert });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    const path = decodeURIComponent(String(headers[':path']).split('?')[0]!);
    // The server's view when Chrome reports net::ERR_FAILED for a module (a rare flake).
    stream.on('error', (error) => console.error(`[page-server] ${path}: stream error ${error.message}`));
    stream.on('close', () => {
      if (stream.rstCode !== 0 && stream.rstCode !== 8) console.error(`[page-server] ${path}: rst=${stream.rstCode} finished=${stream.writableFinished}`);
    });
    if (path === '/') {
      stream.respond({ ':status': 200, 'content-type': 'text/html; charset=utf-8' });
      return void stream.end(`<!doctype html><meta charset="utf-8"><title>apü browser suite</title>
<script type="module">import { run } from '/test/browser/suite.ts'; window.__run = run;</script>`);
    }
    const file = normalize(join(ROOT, path));
    const allowed = (file.startsWith(join(ROOT, 'src') + '/') || file.startsWith(join(ROOT, 'test', 'browser') + '/')) && file.endsWith('.ts');
    if (!allowed || !existsSync(file)) {
      stream.respond({ ':status': 404 });
      return void stream.end();
    }
    stream.respond({ ':status': 200, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    stream.end(stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => (sessions.add(s), s.on('close', () => sessions.delete(s))));
  server.on('sessionError', (error) => console.error(`[page-server] session error ${error.message}`));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sessions) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Minimal JSON-RPC-over-WebSocket client (CDP and WebDriver BiDi share the shape).

async function rpc(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let id = 0;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const events: Array<{ method: string; params: any }> = []; // kept for diagnostics, bounded
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.method && events.length < 500) events.push({ method: msg.method, params: msg.params });
    const entry = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(typeof msg.error === 'string' ? `${msg.error}: ${msg.message}` : msg.error.message));
    else entry.resolve(msg.result);
  };
  return {
    send(method: string, params: object = {}): Promise<any> {
      const message = { id: ++id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        ws.send(JSON.stringify(message));
      });
    },
    events,
    close: () => ws.close(),
  };
}

/** What went wrong while a page loaded: exceptions, console errors, failed requests (CDP events). */
function pageProblems(events: Array<{ method: string; params: any }>): string {
  const lines: string[] = [];
  for (const { method, params } of events) {
    if (method === 'Runtime.exceptionThrown') lines.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
    else if (method === 'Log.entryAdded' && params.entry.level === 'error') lines.push(`log: ${params.entry.text} ${params.entry.url ?? ''}`);
    else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') lines.push(`console: ${params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
    else if (method === 'Network.loadingFailed') lines.push(`request failed: ${params.errorText} (${params.type})`);
    else if (method === 'Network.responseReceived' && params.response.status >= 400) lines.push(`HTTP ${params.response.status} ${params.response.url}`);
  }
  return lines.length ? lines.slice(0, 20).join('; ') : 'no exceptions, console errors or failed requests recorded';
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Kills the browser, waits for it to exit (it keeps writing its profile until then), removes the profile. */
async function stop(proc: ChildProcess, dir: string): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGKILL');
    await exited;
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Opens pageUrl, waits until `ready` is truthy, then evaluates `expression` (a promise of a JSON string). */
async function runInChrome(binary: string, pageUrl: string, ready: string, expression: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'apue-chrome-'));
  const proc = spawn(
    binary,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore' },
  );
  try {
    const port = await until('DevToolsActivePort', async () => (existsSync(join(dir, 'DevToolsActivePort')) ? readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0] || undefined : undefined));
    const target = await until('page target', async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      return targets.find((t) => t.type === 'page');
    });
    const cdp = await rpc(target.webSocketDebuggerUrl);
    await Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable'].map((m) => cdp.send(m)));
    // Chrome sometimes resets a fresh TCP connection while module requests are in flight on it
    // (both servers log `read ECONNRESET`, nothing else; also a plain node:http2 static server, so
    // not apü's) and the module fails with net::ERR_FAILED — ~1 in 5 runs on a busy machine. Such a
    // page load is retried once, and reported; any other failure fails at once.
    for (let attempt = 1; ; attempt++) {
      cdp.events.length = 0;
      await cdp.send('Page.navigate', { url: pageUrl });
      try {
        await until('page ready', async () => ((await cdp.send('Runtime.evaluate', { expression: ready, returnByValue: true })).result.value ? true : undefined));
        break;
      } catch (error) {
        const problems = pageProblems(cdp.events);
        if (attempt === 1 && /request failed: net::ERR_FAILED \(Script\)/.test(problems)) {
          console.error(`[harness] Chrome: a module request failed with net::ERR_FAILED; reloading once (${problems.slice(0, 200)})`);
          continue;
        }
        throw new Error(`${(error as Error).message}: ${problems}`);
      }
    }
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    cdp.close();
    if (evaluated.exceptionDetails) throw new Error(`suite threw: ${JSON.stringify(evaluated.exceptionDetails).slice(0, 500)}`);
    return JSON.parse(evaluated.result.value);
  } finally {
    await stop(proc, dir);
  }
}

async function runInWebKit(_binary: string, pageUrl: string, ready: string, expression: string): Promise<unknown> {
  const { webkit } = await import('playwright-core');
  // WEBKIT_ENDPOINT: a Playwright WebKit server elsewhere (scripts/test-linux-webkit.sh runs Linux
  // WebKit in Docker); its loopback traffic is routed back here, so the test servers stay local.
  const endpoint = process.env.WEBKIT_ENDPOINT;
  const browser = endpoint ? await webkit.connect(endpoint, { exposeNetwork: '<loopback>' }) : await webkit.launch();
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await page.goto(pageUrl);
    await page.waitForFunction(ready, undefined, { timeout: 20_000 });
    return JSON.parse((await page.evaluate(expression)) as string);
  } finally {
    await browser.close();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Waits for Firefox to announce its WebDriver BiDi endpoint on stderr and returns it. Fails at once
 * if Firefox exits, and with its output either way: a launch that once timed out on a busy CI runner
 * (a full 30 s, output discarded) said nothing about why.
 */
function bidiEndpoint(proc: ChildProcess, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let output = '';
  return new Promise((resolve, reject) => {
    const done = (error?: Error, url?: string) => {
      clearTimeout(timer);
      proc.stderr!.off('data', onData);
      proc.off('exit', onExit);
      if (error) reject(error);
      else resolve(url!);
    };
    const tail = () => output.slice(-2000) || '(no output)';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const url = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(output)?.[1];
      if (!url) return;
      const ms = Date.now() - started;
      if (ms > 10_000) console.error(`[harness] Firefox took ${ms} ms to start`);
      done(undefined, url);
    };
    const onExit = (code: number | null, signal: string | null) => done(new Error(`Firefox exited before listening (code ${code}, signal ${signal}): ${tail()}`));
    const timer = setTimeout(() => done(new Error(`Firefox did not announce its WebDriver BiDi endpoint within ${timeoutMs} ms: ${tail()}`)), timeoutMs);
    proc.stderr!.on('data', onData);
    proc.once('exit', onExit);
  });
}

async function runInFirefox(binary: string, pageUrl: string, ready: string, expression: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'apue-firefox-'));
  const port = await freePort();
  const proc = spawn(binary, ['--headless', '--no-remote', '--profile', dir, '--remote-debugging-port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const endpoint = await bidiEndpoint(proc, 60_000);
    proc.stderr!.resume(); // keep draining: a full pipe would block Firefox
    const bidi = await until('WebDriver BiDi session', async () => rpc(`${endpoint}/session`), 10_000);
    await bidi.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    const tree = await bidi.send('browsingContext.getTree', {});
    const context = tree.contexts[0].context;
    await bidi.send('browsingContext.navigate', { context, url: pageUrl, wait: 'complete' });
    const evaluate = (expression: string, awaitPromise: boolean) => bidi.send('script.evaluate', { expression, target: { context }, awaitPromise });
    await until('page ready', async () => ((await evaluate(ready, false)).result.value ? true : undefined));
    const evaluated = await evaluate(expression, true);
    await bidi.send('session.end', {}).catch(() => {});
    bidi.close();
    if (evaluated.type === 'exception') throw new Error(`suite threw: ${JSON.stringify(evaluated.exceptionDetails).slice(0, 500)}`);
    return JSON.parse(evaluated.result.value);
  } finally {
    await stop(proc, dir);
  }
}
