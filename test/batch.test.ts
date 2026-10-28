// S3: pipelined batches — dependent calls in one round trip, lanes delivered out of order.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport, type TransportRequest } from '../src/client.ts';
import { encodeFrame, endFrame, FrameType, msgFrame } from '../src/frame.ts';
import { ApueError, MediaType } from '../src/protocol.ts';
import { encodeArgs, Ref, resolveRefs, collectRefs, RefError } from '../src/refs.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const User = t.object({ id: t.string(), name: t.string(), manager: t.optional(t.object({ id: t.string() })) });

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: User }),
  'orders.list': op({ effect: 'safe', input: t.object({ userId: t.string() }), output: t.array(t.object({ id: t.number(), total: t.number() })) }),
  'slow.get': op({ effect: 'safe', input: t.object({ ms: t.number(), value: t.string() }), output: t.string() }),
  'fail.get': op({ effect: 'safe', input: t.void(), output: t.object({ id: t.string() }) }),
  'echo.get': op({ effect: 'safe', input: t.object({ value: t.unknown() }), output: t.object({ value: t.unknown() }) }),
  'count.inc': op({ effect: 'unsafe', input: t.object({ by: t.number() }), output: t.object({ count: t.number() }) }),
  'feed.watch': op({ effect: 'safe', stream: 'server', input: t.object({ n: t.number() }), output: t.number() }),
  'files.upload': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'feed.stuck': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
});

let counter = 0;
let aborted: string[] = [];

const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id, name: `user ${id}`, ...(id === 'boss' ? {} : { manager: { id: 'boss' } }) }),
  'orders.list': ({ userId }) => [{ id: userId.length, total: 9.5 }],
  'slow.get': async ({ ms, value }, ctx) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        aborted.push(value);
        reject(ctx.signal.reason);
      });
    });
    return value;
  },
  'fail.get': () => {
    throw new ApueError(404, 'Not Found', 'no such thing');
  },
  'echo.get': ({ value }) => ({ value }),
  'count.inc': ({ by }) => ({ count: (counter += by) }),
  'feed.watch': async function* ({ n }) {
    for (let i = 0; i < n; i++) yield i;
  },
  'feed.stuck': async function* () {
    yield 1;
    await new Promise(() => {}); // ignores its signal
  },
  'files.upload': async (inputs) => {
    let n = 0;
    for await (const _ of inputs) n++;
    return n;
  },
};

function recording(inner: Transport) {
  const log: TransportRequest[] = [];
  return {
    log,
    transport: {
      request: (req: TransportRequest) => (log.push(req), inner.request(req)),
      close: () => inner.close?.() ?? Promise.resolve(),
    } satisfies Transport,
  };
}

let server: { url: string; close(): Promise<void> };
let base: Transport;
before(async () => {
  server = await startServer(api, handlers);
  base = http2Transport(server.url, { ca: testCert().cert });
});
after(async () => {
  await base.close?.();
  await server.close();
});
afterEach(() => {
  aborted = [];
});

const rawBatch = (body: unknown, method = 'POST', headers: Record<string, string> = {}) =>
  fetch(`${server.url}/`, { method, headers: { 'content-type': MediaType.JSON, ...headers }, body: JSON.stringify(body) });

describe('pipelined batches', () => {
  test('dependent calls in one request (QUERY when all calls are safe)', async () => {
    const { log, transport } = recording(base);
    const batch = new ApueClient(api, transport).batch();
    const user = batch.call('users.get', { id: 'alice' });
    const manager = batch.call('users.get', { id: user.ref('manager', 'id') });
    const orders = batch.call('orders.list', { userId: user.ref('id') });
    await batch.send();
    assert.deepEqual(await user.result, { id: 'alice', name: 'user alice', manager: { id: 'boss' } });
    assert.deepEqual(await manager.result, { id: 'boss', name: 'user boss' });
    assert.deepEqual(await orders.result, [{ id: 5, total: 9.5 }]);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.method, 'QUERY');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(log[0]!.body as Uint8Array)).calls[1], { in: { id: { $ref: [0, 'manager', 'id'] } }, op: 'users.get' });
  });

  test('lanes are delivered as they complete, independent calls run concurrently', async () => {
    const batch = new ApueClient(api, base).batch();
    const started = performance.now();
    const slow = batch.call('slow.get', { ms: 300, value: 'slow' });
    const fast = batch.call('slow.get', { ms: 20, value: 'fast' });
    const other = batch.call('slow.get', { ms: 300, value: 'other' });
    const sent = batch.send();
    assert.equal(await fast.result, 'fast');
    const fastAt = performance.now() - started;
    await sent;
    const total = performance.now() - started;
    assert.ok(fastAt < 200, `fast lane after ${fastAt.toFixed(0)} ms`);
    assert.ok(total < 550, `two 300 ms calls ran concurrently: ${total.toFixed(0)} ms`);
    assert.deepEqual([await slow.result, await other.result], ['slow', 'other']);
  });

  test('a failed call fails its dependents with 424, independent calls still succeed', async () => {
    const batch = new ApueClient(api, base).batch();
    const missing = batch.call('fail.get');
    const dependent = batch.call('users.get', { id: missing.ref('id') });
    const transitive = batch.call('orders.list', { userId: dependent.ref('id') });
    const independent = batch.call('users.get', { id: 'bob' });
    await batch.send();
    await assert.rejects(missing.result, (e: ApueError) => e.status === 404);
    await assert.rejects(dependent.result, (e: ApueError) => e.status === 424 && /call 0/.test(e.problem.detail ?? ''));
    await assert.rejects(transitive.result, (e: ApueError) => e.status === 424 && /call 1/.test(e.problem.detail ?? ''));
    assert.equal((await independent.result).id, 'bob');
  });

  test('references are resolved, then validated against the input schema', async () => {
    const batch = new ApueClient(api, base).batch();
    const boss = batch.call('users.get', { id: 'boss' });
    const noManager = batch.call('users.get', { id: boss.ref('manager', 'id') }); // boss has no manager
    const wrongType = batch.call('orders.list', { userId: batch.call('orders.list', { userId: 'x' }).ref(0, 'id') as never });
    await batch.send();
    await assert.rejects(noManager.result, (e: ApueError) => e.status === 400 && e.problem.title === 'Unresolvable Reference');
    await assert.rejects(wrongType.result, (e: ApueError) => e.status === 400 && e.problem.title === 'Validation Failed');
  });

  test('data that looks like a reference is escaped and returned verbatim', async () => {
    const batch = new ApueClient(api, base).batch();
    const looksLikeRef = { $ref: [0, 'id'] };
    const looksLikeLit = { $lit: 'x' };
    const a = batch.call('echo.get', { value: looksLikeRef });
    const b = batch.call('echo.get', { value: [looksLikeLit, { nested: looksLikeRef }] });
    await batch.send();
    assert.deepEqual(await a.result, { value: looksLikeRef });
    assert.deepEqual(await b.result, { value: [looksLikeLit, { nested: looksLikeRef }] });
  });

  test('server-streaming calls inside a batch', async () => {
    const batch = new ApueClient(api, base).batch();
    const feed = batch.stream('feed.watch', { n: 5 });
    const user = batch.call('users.get', { id: 'c' });
    await batch.send();
    assert.deepEqual(await Array.fromAsync(feed), [0, 1, 2, 3, 4]);
    assert.equal((await user.result).id, 'c');
  });

  test('batches with non-safe calls use POST and per-call idempotency keys', async () => {
    const { log, transport } = recording(base);
    const batch = new ApueClient(api, transport).batch();
    const before = counter;
    const inc = batch.call('count.inc', { by: 2 });
    const user = batch.call('users.get', { id: 'd' });
    await batch.send();
    assert.equal((await inc.result).count, before + 2);
    assert.equal((await user.result).id, 'd');
    assert.equal(log[0]!.method, 'POST');
    const calls = JSON.parse(new TextDecoder().decode(log[0]!.body as Uint8Array)).calls;
    assert.match(calls[0].key, /^[0-9a-f-]{36}$/);
    assert.equal(calls[1].key, undefined);
  });

  test('resending the same batch replays keyed calls instead of executing them again', async () => {
    const body = { calls: [{ op: 'count.inc', in: { by: 10 }, key: 'batch-replay-1' }] };
    const first = await (await rawBatch(body)).arrayBuffer();
    const countAfterFirst = counter;
    const second = await (await rawBatch(body)).arrayBuffer();
    assert.equal(counter, countAfterFirst);
    assert.deepEqual(new Uint8Array(second), new Uint8Array(first));
  });

  test('cancelling a batch aborts running calls on the server', async () => {
    const controller = new AbortController();
    const batch = new ApueClient(api, base).batch();
    const slow = batch.call('slow.get', { ms: 5_000, value: 'cancel-me' });
    const sent = batch.send({ signal: controller.signal });
    await sleep(50);
    controller.abort(new Error('user abort'));
    await assert.rejects(sent, /user abort/);
    await assert.rejects(slow.result, /user abort/);
    for (let i = 0; i < 50 && aborted.length === 0; i++) await sleep(10);
    assert.deepEqual(aborted, ['cancel-me']);
  });

  test('the deadline applies to the whole batch', async () => {
    const batch = new ApueClient(api, base).batch();
    const quick = batch.call('slow.get', { ms: 1, value: 'quick' });
    const slow = batch.call('slow.get', { ms: 5_000, value: 'late' });
    await batch.send({ timeoutMs: 100 });
    assert.equal(await quick.result, 'quick');
    await assert.rejects(slow.result, (e: ApueError) => e.status === 504);
  });

  test('the deadline also ends a stuck streaming lane', async () => {
    const batch = new ApueClient(api, base).batch();
    const stuck = batch.stream('feed.stuck');
    const quick = batch.call('users.get', { id: 'q' });
    const started = performance.now();
    await batch.send({ timeoutMs: 150 });
    assert.ok(performance.now() - started < 1_000);
    const seen: number[] = [];
    await assert.rejects(
      async () => {
        for await (const n of stuck) seen.push(n);
      },
      (e: ApueError) => e.status === 504,
    );
    assert.deepEqual(seen, [1]);
    assert.equal((await quick.result).id, 'q');
  });

  test('lanes without END fail as truncated', async () => {
    const fake: Transport = {
      async request() {
        async function* body() {
          yield msgFrame({ id: '1', name: 'x' }, 0);
          yield endFrame({ status: 200 }, 0);
          yield msgFrame({ id: '2', name: 'y' }, 1); // lane 1 never ends: proxy cut the stream
        }
        return { status: 200, headers: new Headers({ 'content-type': MediaType.STREAM_JSON }), body: body() };
      },
    };
    const batch = new ApueClient(api, fake).batch();
    const a = batch.call('users.get', { id: '1' });
    const b = batch.call('users.get', { id: '2' });
    await batch.send();
    assert.equal((await a.result).id, '1');
    await assert.rejects(b.result, (e: ApueError) => e.status === 502 && e.problem.title === 'Truncated Stream');
    void encodeFrame;
    void FrameType;
  });
});

describe('batch validation', () => {
  test('client: refs must point to earlier calls; plain inputs are validated before sending', () => {
    const client = new ApueClient(api, base);
    const other = client.batch().call('users.get', { id: 'a' });
    const batch = client.batch();
    batch.call('users.get', { id: 'x' });
    assert.throws(() => batch.call('users.get', { id: new Ref(5, ['id']) as never }), /earlier call/);
    assert.throws(() => batch.call('count.inc', { by: 'one' as never }), (e: ApueError) => e.status === 400);
    void other;
  });

  test('server rejects malformed batches as a whole (400 Invalid Batch)', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /expected/],
      [{ calls: [] }, /1 to 64/],
      [{ calls: Array.from({ length: 65 }, () => ({ op: 'users.get', in: { id: 'x' } })) }, /1 to 64/],
      [{ calls: [{ op: 'nope' }] }, /unknown operation/],
      [{ calls: [{ op: 'files.upload' }] }, /request stream/],
      [{ calls: [{ op: 'users.get', in: { id: { $ref: [0, 'id'] } } }] }, /not earlier/],
      [{ calls: [{ op: 'users.get', in: { id: { $ref: ['0'] } } }] }, /non-negative integer/],
      [{ calls: [{ op: 'users.get', in: { id: { $ref: [0, '__proto__'] } } }, { op: 'users.get', in: { id: { $ref: [0, '__proto__'] } } }] }, /not earlier|not allowed/],
      [{ calls: [{ op: 'feed.watch', in: { n: 1 } }, { op: 'users.get', in: { id: { $ref: [0] } } }] }, /streaming call 0/],
      [{ calls: [{ op: 'users.get', in: { id: 'a' }, key: 5 }] }, /invalid key/],
    ];
    for (const [body, detail] of cases) {
      const res = await rawBatch(body);
      const problem = await res.json();
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(problem.title, 'Invalid Batch');
      assert.match(problem.detail, detail);
    }
  });

  test('QUERY batches must be safe (422); GET is not allowed (405)', async () => {
    const res = await rawBatch({ calls: [{ op: 'count.inc', in: { by: 1 } }] }, 'QUERY');
    assert.equal(res.status, 422);
    await res.arrayBuffer();
    const get = await fetch(`${server.url}/`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'QUERY, POST');
    await get.arrayBuffer();
  });
});

describe('refs codec', () => {
  test('encodeArgs escapes look-alikes, resolveRefs unescapes and follows paths', () => {
    const encoded = encodeArgs({ a: new Ref(0, ['x', 1]), b: { $ref: 'data' }, c: [{ $lit: 1 }], d: { $ref: 1, other: 2 } });
    assert.deepEqual(JSON.parse(JSON.stringify(encoded)), {
      a: { $ref: [0, 'x', 1] },
      b: { $lit: { $ref: 'data' } },
      c: [{ $lit: { $lit: 1 } }],
      d: { $ref: 1, other: 2 },
    });
    const wire = JSON.parse(JSON.stringify(encoded));
    assert.deepEqual([...collectRefs(wire, 1)], [0]);
    assert.deepEqual(resolveRefs(wire, () => ({ x: ['zero', 'one'] })), { a: 'one', b: { $ref: 'data' }, c: [{ $lit: 1 }], d: { $ref: 1, other: 2 } });
    assert.throws(() => resolveRefs({ $ref: [0, 'missing'] }, () => ({})), RefError);
    assert.throws(() => resolveRefs({ $ref: [0, 'toString'] }, () => ({})), RefError); // own properties only
  });
});
