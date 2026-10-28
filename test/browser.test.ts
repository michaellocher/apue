// S5: runs test/browser/suite.ts inside real browsers — headless Chrome (CDP) and Firefox
// (WebDriver BiDi) — against an apü server on a different origin (CORS). The page and the
// src/*.ts modules are served type-stripped by node:module, so there is no build step here either.
// Browsers that aren't installed are skipped.
import assert from 'node:assert/strict';
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
import { sleep, startServer, testCert } from './helpers.ts';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIREFOX = process.env.FIREFOX_PATH ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const ROOT = resolve(import.meta.dirname, '..');

let cancelledStreams = 0;
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
  'echo.duplex': async function* (inputs, ctx) {
    lastDuplexVersion = `HTTP/${ctx.httpVersion}`;
    for await (const value of inputs) yield { echo: value };
  },
};

let page: { url: string; close(): Promise<void> };
let api: { url: string; close(): Promise<void> };

before(async () => {
  page = await startPageServer();
  api = await startServer(browserApi, handlers, { cors: { origins: [page.url] } });
});
after(async () => {
  await api?.close();
  await page?.close();
});

describe('in real browsers', () => {
  for (const [name, binary, drive] of [
    ['Chrome (headless, CDP)', CHROME, runInChrome],
    ['Firefox (headless, WebDriver BiDi)', FIREFOX, runInFirefox],
  ] as const) {
    test(name, { skip: existsSync(binary) ? false : `${binary} not installed`, timeout: 90_000 }, async (t) => {
      const results = await drive(binary, `${page.url}/`, api.url);
      for (const r of results) t.diagnostic(`${r.ok ? (r.skipped ? 'SKIP' : 'ok  ') : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      const failed = results.filter((r) => !r.ok);
      assert.deepEqual(failed, [], `${name}: ${failed.map((f) => `${f.name}: ${f.detail}`).join('; ')}`);
      assert.ok(results.length >= 13, `only ${results.length} checks ran`);
    });
  }
});

void ApueError;

// ---------------------------------------------------------------------------------------------
// Page server: index.html plus type-stripped .ts modules from src/ and test/browser/.

async function startPageServer(): Promise<{ url: string; close(): Promise<void> }> {
  const { key, cert } = testCert();
  const server = http2.createSecureServer({ key, cert });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    const path = decodeURIComponent(String(headers[':path']).split('?')[0]!);
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
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
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
    close: () => ws.close(),
  };
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

async function runInChrome(binary: string, pageUrl: string, apiUrl: string): Promise<CheckResult[]> {
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
    await cdp.send('Page.navigate', { url: pageUrl });
    await until('suite module', async () => ((await cdp.send('Runtime.evaluate', { expression: "typeof window.__run === 'function'", returnByValue: true })).result.value ? true : undefined));
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `window.__run(${JSON.stringify(apiUrl)}).then(JSON.stringify)`,
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function runInFirefox(binary: string, pageUrl: string, apiUrl: string): Promise<CheckResult[]> {
  const dir = mkdtempSync(join(tmpdir(), 'apue-firefox-'));
  const port = await freePort();
  const proc = spawn(binary, ['--headless', '--no-remote', '--profile', dir, '--remote-debugging-port', String(port)], { stdio: 'ignore' });
  try {
    const bidi = await until('WebDriver BiDi endpoint', async () => rpc(`ws://127.0.0.1:${port}/session`), 30_000);
    await bidi.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    const tree = await bidi.send('browsingContext.getTree', {});
    const context = tree.contexts[0].context;
    await bidi.send('browsingContext.navigate', { context, url: pageUrl, wait: 'complete' });
    const evaluate = (expression: string, awaitPromise: boolean) => bidi.send('script.evaluate', { expression, target: { context }, awaitPromise });
    await until('suite module', async () => ((await evaluate("typeof window.__run === 'function'", false)).result.value ? true : undefined));
    const evaluated = await evaluate(`window.__run(${JSON.stringify(apiUrl)}).then(JSON.stringify)`, true);
    await bidi.send('session.end', {}).catch(() => {});
    bidi.close();
    if (evaluated.type === 'exception') throw new Error(`suite threw: ${JSON.stringify(evaluated.exceptionDetails).slice(0, 500)}`);
    return JSON.parse(evaluated.result.value);
  } finally {
    await stop(proc, dir);
  }
}
