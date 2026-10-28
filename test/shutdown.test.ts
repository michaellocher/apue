// Bounded shutdown and idle cleanup: close() waits for calls in flight only `shutdownGraceMs`, then
// ends the rest with a retryable 503; an idle session that GOAWAY can't finish is destroyed.
// Before: an endless stream or an open request stream kept close() pending forever.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { decodeFrames, decodeJson, FrameType } from '../src/frame.ts';
import { ApueError, MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  ticker: op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  sink: op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  slow: op({ effect: 'safe', input: t.object({ ms: t.number() }), output: t.string() }),
});
const aborts: unknown[] = [];
const handlers: Handlers<typeof api> = {
  ticker: async function* () {
    for (let i = 0; ; i++) {
      yield i;
      await sleep(20);
    }
  },
  sink: async (inputs, ctx) => {
    ctx.signal.addEventListener('abort', () => aborts.push(ctx.signal.reason));
    let n = 0;
    for await (const _ of inputs) n++;
    return n;
  },
  slow: async ({ ms }) => {
    await sleep(ms);
    return 'done';
  },
};
const timed = async (promise: Promise<unknown>) => {
  const t0 = performance.now();
  await promise;
  return performance.now() - t0;
};
const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([promise, sleep(ms).then(() => assert.fail(`${what}: not within ${ms} ms`))]);

test('an endless stream: close() ends it after the grace period with a retryable 503 END frame', async () => {
  const server = await startServer(api, handlers, { shutdownGraceMs: 300 });
  const res = await fetch(`${server.url}/ticker`, { headers: { accept: MediaType.STREAM_JSON } });
  const frames = (async () => {
    let items = 0;
    let end: { status: number; problem?: { retryable?: boolean } } | undefined;
    for await (const frame of decodeFrames(res.body!)) {
      if (frame.type === FrameType.MSG) items++;
      if (frame.type === FrameType.END) end = decodeJson(frame.payload) as never;
    }
    return { items, end };
  })();
  await sleep(100);
  const elapsed = await within(timed(server.close()), 2_500, 'close()');
  assert.ok(elapsed >= 280, `close() took ${elapsed} ms: it must give calls the grace period`);
  const { items, end } = await within(frames, 1_000, 'the stream ending');
  assert.ok(items > 0);
  assert.equal(end?.status, 503);
  assert.equal(end?.problem?.retryable, true);
});

test('an open request stream: the handler is aborted with 503 and close() completes', async () => {
  aborts.length = 0;
  const server = await startServer(api, handlers, { shutdownGraceMs: 200 });
  const session = http2.connect(server.url, { ca: testCert().cert });
  session.on('error', () => {});
  const req = session.request({ ':method': 'POST', ':path': '/sink', 'content-type': MediaType.STREAM_JSON });
  req.on('error', () => {});
  req.write(new Uint8Array(0)); // open, never ended
  const status = new Promise((resolve) => req.on('response', (h) => resolve(h[':status'])));
  await sleep(100);
  await within(server.close(), 2_500, 'close()');
  assert.equal(await within(status, 1_000, 'a response'), 503);
  assert.ok(aborts.some((reason) => reason instanceof ApueError && reason.status === 503), 'the handler saw the shutdown');
  session.destroy();
});

test('calls that finish within the grace period are not cut, and close() returns when they are done', async () => {
  const server = await startServer(api, handlers, { shutdownGraceMs: 5_000 });
  const call = fetch(`${server.url}/slow?i=${encodeURIComponent(JSON.stringify({ ms: 300 }))}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  await sleep(50);
  const elapsed = await timed(server.close());
  assert.deepEqual(await call, { status: 200, body: 'done' });
  assert.ok(elapsed < 2_000, `close() waited ${elapsed} ms although the only call was done after ~250`);
});

test('shutdownGraceMs: Infinity waits for every call; invalid values are a startup error', async () => {
  const server = await startServer(api, handlers, { shutdownGraceMs: Infinity });
  const call = fetch(`${server.url}/slow?i=${encodeURIComponent(JSON.stringify({ ms: 600 }))}`).then((r) => r.status);
  await sleep(50);
  const elapsed = await timed(server.close());
  assert.equal(await call, 200);
  assert.ok(elapsed >= 500, `${elapsed}`);
  for (const shutdownGraceMs of [-1, Number.NaN]) {
    assert.throws(() => createApueServer(api, handlers, { ...testCert(), shutdownGraceMs }), RangeError);
  }
});

test('an idle session that GOAWAY cannot finish (a silent open stream) is destroyed one idle period later', async () => {
  // Node fires a session timeout once; the GOAWAY it sent waits for the open stream forever.
  const server = await startServer(api, handlers, { idleTimeoutMs: 200 });
  const session = http2.connect(server.url, { ca: testCert().cert });
  session.on('error', () => {});
  let goaway = 0;
  session.on('goaway', () => (goaway = performance.now()));
  const t0 = performance.now();
  const req = session.request({ ':method': 'POST', ':path': '/sink', 'content-type': MediaType.STREAM_JSON });
  req.on('error', () => {});
  req.write(new Uint8Array(0)); // silent from now on
  await within(new Promise((resolve) => session.on('close', resolve)), 2_000, 'the stuck session being dropped');
  assert.ok(goaway > 0, 'GOAWAY first');
  assert.ok(performance.now() - t0 >= 380, 'destroyed only after a second idle period');
  await within(server.close(), 1_000, 'close()');
});
