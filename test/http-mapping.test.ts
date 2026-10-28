// S2 behaviour: effect → method mapping, caching, validation, idempotency, retries, manifest.
import assert from 'node:assert/strict';
import https from 'node:https';
import { after, afterEach, before, describe, test, mock } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport, type TransportRequest } from '../src/client.ts';
import { MediaType } from '../src/protocol.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { MANIFEST_PATH, type Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const User = t.object({ id: t.string(), name: t.string() });
const since = new Date('2026-01-01T00:00:00Z');
const sunset = new Date('2027-01-01T00:00:00Z');

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: User, cache: { maxAge: 60, staleWhileRevalidate: 30 } }),
  'users.search': op({ effect: 'safe', input: t.object({ q: t.string(), tags: t.optional(t.array(t.string())) }), output: t.array(User) }),
  'users.mine': op({ effect: 'safe', input: t.void(), output: t.string(), cache: { private: true } }),
  'users.watch': op({ effect: 'safe', stream: 'server', input: t.object({ n: t.number() }), output: t.number() }),
  'users.leaky': op({ effect: 'safe', input: t.void(), output: User }),
  'users.broken': op({ effect: 'safe', input: t.void(), output: t.object({ n: t.number() }) }),
  'users.old': op({ effect: 'safe', input: t.void(), output: t.string(), deprecated: { since, sunset, link: 'https://example.com/migrate' } }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string(), qty: t.number({ int: true, min: 1 }) }), output: t.object({ orderId: t.number() }) }),
  'orders.slow': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.object({ orderId: t.number() }) }),
  'orders.flaky': op({ effect: 'unsafe', input: t.void(), output: t.object({ attempt: t.number() }) }),
  'orders.payment': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
  'orders.conflict': op({ effect: 'idempotent', input: t.void(), output: t.void() }),
  'orders.upload': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
});

const calls = new Map<string, number>();
const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1).get(name)!;
let nextOrderId = 1;

const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id, name: `user ${id}` }),
  'users.search': ({ q, tags }) => [{ id: '1', name: `${q}:${(tags ?? []).length}` }],
  'users.mine': () => 'mine',
  'users.watch': async function* ({ n }) {
    for (let i = 0; i < n; i++) yield i;
  },
  'users.leaky': () => ({ id: '1', name: 'a', passwordHash: 'secret' }) as never,
  'users.broken': () => ({ n: 'not a number' }) as never,
  'users.old': () => 'old',
  'orders.create': () => {
    count('orders.create');
    return { orderId: nextOrderId++ };
  },
  'orders.slow': async () => {
    count('orders.slow');
    await sleep(200);
    return { orderId: nextOrderId++ };
  },
  'orders.flaky': () => {
    const attempt = count('orders.flaky');
    if (attempt < 3) throw new ApueError(503, 'Service Unavailable', 'try again', {}, { 'retry-after': '0' });
    return { attempt };
  },
  'orders.payment': () => {
    count('orders.payment');
    throw new ApueError(402, 'Payment Required');
  },
  'orders.conflict': () => {
    count('orders.conflict');
    throw new ApueError(409, 'Conflict', 'business rule');
  },
  'orders.upload': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
};

/** Wraps a transport, recording requests; optionally lets a test interpose (e.g. a proxy rejecting QUERY). */
function recording(inner: Transport, interpose?: (req: TransportRequest) => Promise<Awaited<ReturnType<Transport['request']>>> | undefined) {
  const log: TransportRequest[] = [];
  const transport: Transport = {
    request(req) {
      log.push(req);
      return interpose?.(req) ?? inner.request(req);
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
  return { log, transport };
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
afterEach(() => calls.clear());

const raw = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, init);
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': MediaType.JSON, ...headers },
  body: JSON.stringify(body),
});

describe('effect → HTTP method', () => {
  test('safe op with small input → GET with canonical input in the URL', async () => {
    const { log, transport } = recording(base);
    const client = new ApueClient(api, transport);
    assert.deepEqual(await client.call('users.search', { tags: ['b'], q: 'x' }), [{ id: '1', name: 'x:1' }]);
    assert.equal(log[0]!.method, 'GET');
    assert.equal(log[0]!.path, `/users.search?i=${encodeURIComponent('{"q":"x","tags":["b"]}')}`);
    assert.equal(log[0]!.body, undefined);
  });

  test('safe op with large input → QUERY with canonical JSON body', async () => {
    const { log, transport } = recording(base);
    const client = new ApueClient(api, transport);
    const tags = Array.from({ length: 300 }, (_, i) => `tag-${i}`);
    assert.deepEqual(await client.call('users.search', { tags, q: 'big' }), [{ id: '1', name: 'big:300' }]);
    assert.equal(log[0]!.method, 'QUERY');
    assert.equal(new TextDecoder().decode(log[0]!.body as Uint8Array), JSON.stringify({ q: 'big', tags }));
  });

  test('intermediary rejecting QUERY → POST fallback, remembered for later calls', async () => {
    const { log, transport } = recording(base, (req) =>
      req.method === 'QUERY' ? Promise.resolve({ status: 405, headers: new Headers(), body: (async function* () {})() }) : undefined,
    );
    const client = new ApueClient(api, transport);
    const tags = Array.from({ length: 300 }, (_, i) => `t${i}`);
    assert.equal((await client.call('users.search', { q: 'a', tags }))[0]!.name, 'a:300');
    assert.equal((await client.call('users.search', { q: 'b', tags }))[0]!.name, 'b:300');
    assert.deepEqual(log.map((r) => r.method), ['QUERY', 'POST', 'POST']);
  });

  test('QUERY fallback also covers CloudFront (403) and old Envoy (400); sticky only if POST fares better', async () => {
    const tags = Array.from({ length: 300 }, (_, i) => `t${i}`);
    for (const status of [403, 400, 501]) {
      const { log, transport } = recording(base, (req) =>
        req.method === 'QUERY' ? Promise.resolve({ status, headers: new Headers(), body: (async function* () {})() }) : undefined,
      );
      const client = new ApueClient(api, transport);
      await client.call('users.search', { q: 'a', tags });
      await client.call('users.search', { q: 'b', tags });
      assert.deepEqual(log.map((r) => r.method), ['QUERY', 'POST', 'POST'], `status ${status}`);
    }
    // A genuine error that POST reproduces must not disable QUERY for later calls.
    const { log, transport } = recording(base, (req) =>
      Promise.resolve({ status: 403, headers: new Headers(), body: (async function* () {})() }),
    );
    const client = new ApueClient(api, transport);
    await assert.rejects(client.call('users.search', { q: 'a', tags }), (e: ApueError) => e.status === 403);
    await assert.rejects(client.call('users.search', { q: 'a', tags }), (e: ApueError) => e.status === 403);
    assert.deepEqual(log.map((r) => r.method), ['QUERY', 'POST', 'QUERY', 'POST']);
  });

  test('QUERY without Content-Type → 400 (RFC 10008 §2)', async () => {
    const res = await raw('/users.get', { method: 'QUERY', body: '{"id":"1"}' , headers: { 'content-type': '' } });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('accept-query'), `"${MediaType.JSON}"`);
    await res.arrayBuffer();
  });

  test('streaming uploads carry Incremental: ?1 (RFC 10036 §3)', async () => {
    const { log, transport } = recording(base);
    async function* numbers() {
      yield 1;
      yield 2;
    }
    assert.deepEqual(await Array.fromAsync(new ApueClient(api, transport).duplex('orders.upload', numbers())), [3]);
    assert.equal(log[0]!.headers.incremental, '?1');
  });

  test('unsafe op → POST with a generated Idempotency-Key (sf-string)', async () => {
    const { log, transport } = recording(base);
    await new ApueClient(api, transport).call('orders.create', { item: 'book', qty: 1 });
    assert.equal(log[0]!.method, 'POST');
    assert.match(log[0]!.headers['idempotency-key']!, /^"[0-9a-f-]{36}"$/);
  });

  test('server enforces methods: 405 + Allow', async () => {
    const get = await raw('/orders.create');
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal(get.headers.get('content-type'), MediaType.PROBLEM);
    const put = await raw('/users.get', { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, HEAD, QUERY, POST');
    const manifestPost = await raw(MANIFEST_PATH, { method: 'POST' });
    assert.equal(manifestPost.status, 405);
  });

  test('QUERY and POST work for reads; GET input errors → 400; unknown op → 404', async () => {
    const query = await raw('/users.get', { ...json({ id: '7' }), method: 'QUERY' });
    assert.deepEqual(await query.json(), { id: '7', name: 'user 7' });
    assert.equal(query.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=30');
    assert.deepEqual(await (await raw('/users.get', json({ id: '8' }))).json(), { id: '8', name: 'user 8' });
    assert.equal((await raw('/users.get?i=%7Bnope')).status, 400);
    assert.equal((await raw('/users.get?i=1&i=2')).status, 400);
    assert.equal((await raw('/nope.nothing')).status, 404);
  });

  test('HTTP/1.1 GET works the same', async () => {
    const result = await new Promise<string>((resolve, reject) => {
      https
        .get(`${server.url}/users.get?i=${encodeURIComponent('{"id":"1"}')}`, { ca: testCert().cert }, (res) => {
          let text = `${res.httpVersion} ${res.statusCode} `;
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    assert.equal(result, '1.1 200 {"id":"1","name":"user 1"}');
  });
});

describe('HTTP caching', () => {
  test('ETag + If-None-Match → 304 (strong, weak and list forms)', async () => {
    const path = `/users.get?i=${encodeURIComponent('{"id":"1"}')}`;
    const first = await raw(path);
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^"[\w-]{22}"$/);
    await first.arrayBuffer();
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const again = await raw(path, { headers: { 'if-none-match': inm } });
      assert.equal(again.status, 304, inm);
      assert.equal(again.headers.get('etag'), etag);
      assert.equal(again.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=30');
      assert.equal((await again.arrayBuffer()).byteLength, 0);
    }
    assert.equal((await raw(path, { headers: { 'if-none-match': '"stale"' } })).status, 200);
  });

  test('Cache-Control follows the op policy; non-safe ops are no-store', async () => {
    const cc = async (res: Response) => (await res.arrayBuffer(), res.headers.get('cache-control'));
    assert.equal(await cc(await raw(`/users.search?i=${encodeURIComponent('{"q":"a"}')}`)), 'no-cache');
    assert.equal(await cc(await raw('/users.mine')), 'private, no-cache');
    assert.equal(await cc(await raw('/orders.create', json({ item: 'a', qty: 1 }))), 'no-store');
    assert.equal(await cc(await raw('/users.watch?i=%7B%22n%22%3A1%7D')), 'no-store');
  });

  test('reads advertise Accept-Query', async () => {
    const res = await raw('/users.mine');
    await res.arrayBuffer();
    assert.equal(res.headers.get('accept-query'), `"${MediaType.JSON}"`);
  });

  test('HEAD returns headers without body', async () => {
    const res = await raw(`/users.get?i=${encodeURIComponent('{"id":"1"}')}`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String('{"id":"1","name":"user 1"}'.length));
    assert.ok(res.headers.get('etag'));
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    const stream = await raw('/users.watch?i=%7B%22n%22%3A1%7D', { method: 'HEAD' });
    assert.equal(stream.headers.get('content-type'), MediaType.STREAM_JSON);
  });

  test('streaming reads work over GET', async () => {
    const client = new ApueClient(api, base);
    assert.deepEqual(await Array.fromAsync(client.stream('users.watch', { n: 3 })), [0, 1, 2]);
  });
});

describe('validation', () => {
  test('client validates input before sending', async () => {
    const { log, transport } = recording(base);
    const client = new ApueClient(api, transport);
    await assert.rejects(
      client.call('orders.create', { item: 'x', qty: 0 }),
      (e: ApueError) => e.status === 400 && (e.problem.fields as unknown[]).length === 1,
    );
    assert.equal(log.length, 0);
  });

  test('problem details: apü types for protocol errors, about:blank + status phrase otherwise', async () => {
    const validation = await (await raw('/orders.create', json({ item: 5, qty: 1 }))).json();
    assert.equal(validation.type, 'https://apue.dev/problems/validation-failed');
    const unknown = await (await raw('/nope.nothing')).json();
    assert.equal(unknown.type, 'https://apue.dev/problems/unknown-operation');
    const notAllowed = await (await raw('/orders.create')).json();
    assert.deepEqual(notAllowed, { title: 'Method Not Allowed', status: 405, detail: 'GET is not allowed here' });
  });

  test('server validates input: 400 with field paths', async () => {
    const res = await raw('/orders.create', json({ item: 5, qty: 1.5 }));
    assert.equal(res.status, 400);
    const problem = await res.json();
    assert.equal(problem.title, 'Validation Failed');
    assert.deepEqual(problem.fields, [
      { path: 'item', message: 'expected string, got number' },
      { path: 'qty', message: 'expected integer' },
    ]);
  });

  test('output is stripped to the schema (no accidental field leaks)', async () => {
    assert.deepEqual(await new ApueClient(api, base).call('users.leaky'), { id: '1', name: 'a' });
  });

  test('invalid output → 500 without details', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const res = await raw('/users.broken');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { title: 'Internal Server Error', status: 500 });
    assert.equal(logged.mock.callCount(), 1);
  });

  test('malformed JSON / wrong media type / oversized body', async () => {
    assert.equal((await raw('/orders.create', { method: 'POST', headers: { 'content-type': MediaType.JSON }, body: '{' })).status, 400);
    assert.equal((await raw('/orders.create', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    const big = await raw('/orders.create', json({ item: 'x'.repeat(2 * 1024 * 1024), qty: 1 }));
    assert.equal(big.status, 413);
  });
});

describe('Idempotency-Key', () => {
  const key = (k: string, extra: Record<string, string> = {}) => ({ 'idempotency-key': `"${k}"`, ...extra });

  test('same key + same payload → executed once, replayed with apue-replayed', async () => {
    const a = await raw('/orders.create', json({ item: 'a', qty: 1 }, key('k-replay')));
    const b = await raw('/orders.create', json({ qty: 1, item: 'a' }, key('k-replay')));
    assert.deepEqual(await b.json(), await a.json());
    assert.equal(a.headers.get('apue-replayed'), null);
    assert.equal(b.headers.get('apue-replayed'), '?1');
    assert.equal(calls.get('orders.create'), 1);
  });

  test('same key + different payload → 422', async () => {
    await (await raw('/orders.create', json({ item: 'a', qty: 1 }, key('k-mismatch')))).arrayBuffer();
    const res = await raw('/orders.create', json({ item: 'b', qty: 1 }, key('k-mismatch')));
    assert.equal(res.status, 422);
    assert.equal(calls.get('orders.create'), 1);
  });

  test('concurrent request with the same key → 409 retryable', async () => {
    const [a, b] = await Promise.all([
      raw('/orders.slow', json({ item: 'a' }, key('k-concurrent'))),
      sleep(50).then(() => raw('/orders.slow', json({ item: 'a' }, key('k-concurrent')))),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 409);
    assert.equal((await b.json()).retryable, true);
    assert.equal(calls.get('orders.slow'), 1);
  });

  test('keys are scoped per credentials', async () => {
    await (await raw('/orders.create', json({ item: 'a', qty: 1 }, key('k-scope', { authorization: 'Bearer alice' })))).arrayBuffer();
    const bob = await raw('/orders.create', json({ item: 'a', qty: 1 }, key('k-scope', { authorization: 'Bearer bob' })));
    assert.equal(bob.headers.get('apue-replayed'), null);
    assert.equal(calls.get('orders.create'), 2);
  });

  test('4xx from the handler is stored and replayed; 5xx releases the key', async () => {
    assert.equal((await raw('/orders.payment', { method: 'POST', headers: key('k-402') })).status, 402);
    const again = await raw('/orders.payment', { method: 'POST', headers: key('k-402') });
    assert.equal(again.status, 402);
    assert.equal(again.headers.get('apue-replayed'), '?1');
    assert.equal(calls.get('orders.payment'), 1);

    for (let i = 0; i < 2; i++) assert.equal((await raw('/orders.flaky', { method: 'POST', headers: key('k-5xx') })).status, 503);
    assert.equal((await raw('/orders.flaky', { method: 'POST', headers: key('k-5xx') })).status, 200);
    assert.equal(calls.get('orders.flaky'), 3);
  });

  test('malformed key → 400', async () => {
    assert.equal((await raw('/orders.create', json({ item: 'a', qty: 1 }, { 'idempotency-key': '""' }))).status, 400);
  });
});

describe('client retries', () => {
  test('503 + Retry-After is retried with the same Idempotency-Key', async () => {
    const { log, transport } = recording(base);
    assert.deepEqual(await new ApueClient(api, transport).call('orders.flaky'), { attempt: 3 });
    assert.equal(log.length, 3);
    assert.equal(new Set(log.map((r) => r.headers['idempotency-key'])).size, 1);
  });

  test('retry budget is respected', async () => {
    const { log, transport } = recording(base);
    await assert.rejects(new ApueClient(api, transport, { retries: 1 }).call('orders.flaky'), (e: ApueError) => e.status === 503);
    assert.equal(log.length, 2);
  });

  test('409 in-progress is retried until the original finishes, then replayed', async () => {
    const client = new ApueClient(api, base, { backoffMs: 100, retries: 5 });
    const [a, b] = await Promise.all([
      client.call('orders.slow', { item: 'x' }, { idempotencyKey: 'k-client-409' }),
      sleep(50).then(() => client.call('orders.slow', { item: 'x' }, { idempotencyKey: 'k-client-409' })),
    ]);
    assert.deepEqual(a, b);
    assert.equal(calls.get('orders.slow'), 1);
  });

  test('a business 409 (not retryable) is not retried', async () => {
    const { log, transport } = recording(base);
    await assert.rejects(new ApueClient(api, transport).call('orders.conflict'), (e: ApueError) => e.status === 409);
    assert.equal(log.length, 1);
    assert.equal(calls.get('orders.conflict'), 1);
  });

  test('network errors are retried for safe ops, never for request streams', async () => {
    let failures = 1;
    const flaky = recording(base, () => (failures-- > 0 ? Promise.reject(new Error('ECONNRESET')) : undefined));
    assert.deepEqual(await new ApueClient(api, flaky.transport).call('users.get', { id: '1' }), { id: '1', name: 'user 1' });
    assert.equal(flaky.log.length, 2);

    failures = 1;
    const upload = recording(base, () => (failures-- > 0 ? Promise.reject(new Error('ECONNRESET')) : undefined));
    async function* numbers() {
      yield 1;
    }
    await assert.rejects(Array.fromAsync(new ApueClient(api, upload.transport).duplex('orders.upload', numbers())), /ECONNRESET/);
    assert.equal(upload.log.length, 1);
  });

  test('aborting during backoff stops retrying', async () => {
    const controller = new AbortController();
    const { log, transport } = recording(base, () => Promise.reject(new Error('down')));
    const pending = new ApueClient(api, transport, { backoffMs: 10_000, maxBackoffMs: 10_000 }).call('users.mine', undefined, { signal: controller.signal });
    await sleep(20);
    controller.abort(new Error('user abort'));
    await assert.rejects(pending, /user abort/);
    assert.equal(log.length, 1);
  });
});

describe('deprecation and manifest', () => {
  test('deprecated ops send Deprecation, Sunset and Link', async () => {
    const res = await raw('/users.old');
    await res.arrayBuffer();
    assert.equal(res.headers.get('deprecation'), `@${since.getTime() / 1000}`);
    assert.equal(res.headers.get('sunset'), 'Fri, 01 Jan 2027 00:00:00 GMT');
    assert.equal(res.headers.get('link'), '<https://example.com/migrate>; rel="deprecation"');
  });

  test('manifest describes all ops with JSON Schema and supports 304', async () => {
    const res = await raw(MANIFEST_PATH);
    const manifest = await res.json();
    assert.equal(manifest.apue, 'draft-00');
    assert.deepEqual(Object.keys(manifest.ops), Object.keys(api));
    assert.deepEqual(manifest.ops['users.get'], {
      effect: 'safe',
      stream: 'none',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: User.toJSONSchema(),
      cache: { maxAge: 60, staleWhileRevalidate: 30 },
    });
    assert.equal(manifest.ops['users.old'].deprecated.sunset, sunset.toISOString());
    const again = await raw(MANIFEST_PATH, { headers: { 'if-none-match': res.headers.get('etag')! } });
    assert.equal(again.status, 304);
  });

  test('op() refuses a sunset before the deprecation date (RFC 9745 §4)', () => {
    assert.throws(() => op({ effect: 'safe', input: t.void(), output: t.void(), deprecated: { since: sunset, sunset: since } }), /RFC 9745/);
  });

  test('createApueServer refuses an API with missing handlers', async () => {
    const { createApueServer } = await import('../src/server.ts');
    const { key, cert } = testCert();
    assert.throws(() => createApueServer(api, {} as Handlers<typeof api>, { key, cert }), /missing handler for users.get/);
  });
});

void mock;
