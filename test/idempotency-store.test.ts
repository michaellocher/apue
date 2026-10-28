// Shared idempotency stores (replicas): the store contract may be asynchronous, so a store over
// shared storage (e.g. Redis) lets a retry that lands on another replica be replayed, not re-run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { MemoryIdempotencyStore, type BeginResult, type IdempotencyStore, type StoredResponse } from '../src/idempotency.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { sleep, startServer } from './helpers.ts';

/** Shared storage with network latency: every operation is asynchronous. */
class AsyncStore implements IdempotencyStore {
  readonly inner = new MemoryIdempotencyStore();
  failComplete = false;
  failBegin = false;
  async begin(key: string, fingerprint: string): Promise<BeginResult> {
    await sleep(5);
    if (this.failBegin) throw new Error('store unavailable');
    return this.inner.begin(key, fingerprint);
  }
  async complete(key: string, response: StoredResponse): Promise<void> {
    await sleep(5);
    if (this.failComplete) throw new Error('store unavailable');
    this.inner.complete(key, response);
  }
  async release(key: string): Promise<void> {
    await sleep(5);
    this.inner.release(key);
  }
}

let runs = 0;
const api = defineApi({
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.object({ order: t.number() }) }),
  'orders.slow': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'orders.flaky': op({ effect: 'unsafe', input: t.void(), output: t.number() }),
});
let flaky = 0;
const handlers: Handlers<typeof api> = {
  'orders.create': () => ({ order: ++runs }),
  'orders.slow': async () => {
    await sleep(200);
    return ++runs;
  },
  'orders.flaky': () => {
    if (++flaky === 1) throw new Error('first attempt fails');
    return flaky;
  },
};
const post = (url: string, path: string, key: string, body?: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'idempotency-key': `"${key}"`, ...(body === undefined ? {} : { 'content-type': MediaType.JSON }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('two replicas sharing an asynchronous store: a retry on the other replica is replayed, concurrency is 409', async (ctx) => {
  const store = new AsyncStore();
  const a = await startServer(api, handlers, { idempotency: store });
  const b = await startServer(api, handlers, { idempotency: store });
  ctx.after(async () => {
    await a.close();
    await b.close();
  });
  const before = runs;
  const first = await post(a.url, '/orders.create', 'k-shared', { item: 'x' });
  const retry = await post(b.url, '/orders.create', 'k-shared', { item: 'x' });
  assert.deepEqual(await retry.json(), await first.json());
  assert.equal(retry.headers.get('apue-replayed'), '?1');
  assert.equal(runs, before + 1, 'executed once across replicas');

  const [slow, concurrent] = await Promise.all([post(a.url, '/orders.slow', 'k-concurrent', { item: 'y' }), sleep(60).then(() => post(b.url, '/orders.slow', 'k-concurrent', { item: 'y' }))]);
  assert.equal(slow.status, 200);
  assert.equal(concurrent.status, 409);
  await slow.arrayBuffer();
  await concurrent.arrayBuffer();

  // A server error releases the key (asynchronously too): the retry on the other replica runs.
  ctx.mock.method(console, 'error', () => {});
  assert.equal((await post(a.url, '/orders.flaky', 'k-flaky')).status, 500);
  const recovered = await post(b.url, '/orders.flaky', 'k-flaky');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get('apue-replayed'), null);
});

test('a store that fails: begin → 500 (nothing runs); complete → the response still stands, logged', async (ctx) => {
  const store = new AsyncStore();
  const server = await startServer(api, handlers, { idempotency: store });
  ctx.after(() => server.close());
  const logged: unknown[] = [];
  ctx.mock.method(console, 'error', (...args: unknown[]) => logged.push(args));
  const before = runs;
  store.failBegin = true;
  assert.equal((await post(server.url, '/orders.create', 'k-down', { item: 'z' })).status, 500);
  assert.equal(runs, before, 'nothing ran without a claim');
  store.failBegin = false;
  store.failComplete = true;
  const res = await post(server.url, '/orders.create', 'k-down2', { item: 'z' });
  assert.equal(res.status, 200, 'the operation ran: its result is the response');
  assert.equal(runs, before + 1);
  assert.ok(logged.some((args) => String((args as unknown[])[0]).includes('idempotency store failed')));
});
