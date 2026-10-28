// Field selection: validated against the output schema, applied after validation, part of the URL.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport, type TransportRequest } from '../src/client.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { compileSelection, project, SelectionError } from '../src/select.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { startServer, testCert } from './helpers.ts';

const Address = t.object({ street: t.string(), city: t.string(), zip: t.string() });
const User = t.object({
  id: t.string(),
  name: t.string(),
  email: t.string(),
  address: t.nullable(Address),
  orders: t.array(t.object({ id: t.number(), total: t.number(), items: t.array(t.object({ sku: t.string(), qty: t.number() })) })),
  manager: t.optional(t.object({ id: t.string(), name: t.string() })),
});

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: User }),
  'users.search': op({ effect: 'safe', input: t.object({ tags: t.array(t.string()) }), output: t.array(User) }),
  'users.update': op({ effect: 'unsafe', input: t.object({ id: t.string() }), output: User }),
  'users.watch': op({ effect: 'safe', stream: 'server', input: t.void(), output: User }),
  'count': op({ effect: 'safe', input: t.void(), output: t.number() }),
});

const user = (id: string) => ({
  id,
  name: `user ${id}`,
  email: `${id}@example.com`,
  address: { street: 'Main St 1', city: 'Berlin', zip: '10115' },
  orders: [{ id: 1, total: 9.5, items: [{ sku: 'a', qty: 1 }] }],
  manager: { id: 'boss', name: 'The Boss' },
  secret: 'never sent',
});
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => user(id) as never,
  'users.search': ({ tags }) => tags.map(user) as never,
  'users.update': ({ id }) => user(id) as never,
  'users.watch': async function* () {
    yield user('1') as never;
    yield user('2') as never;
  },
  'count': () => 3,
};

let server: { url: string; close(): Promise<void> };
before(async () => {
  server = await startServer(api, handlers);
});
after(() => server.close());

function recording(inner: Transport) {
  const log: TransportRequest[] = [];
  return { log, transport: { request: (req: TransportRequest) => (log.push(req), inner.request(req)), close: () => inner.close?.() ?? Promise.resolve() } satisfies Transport };
}

describe('selection compiler', () => {
  test('paths through nullable objects, arrays and optional fields; parent selections absorb children', () => {
    assert.deepEqual(compileSelection(User, 'id,address.city,orders.items.sku,manager'), {
      id: true,
      address: { city: true },
      orders: { items: { sku: true } },
      manager: true,
    });
    assert.deepEqual(compileSelection(User, 'address.city,address'), { address: true });
    assert.deepEqual(compileSelection(User, 'address,address.city'), { address: true });
    assert.deepEqual(compileSelection(t.array(User), 'name'), { name: true });
  });

  test('unknown fields, non-object outputs, empty and oversized selections are rejected', () => {
    assert.throws(() => compileSelection(User, 'secret'), (e: Error) => e instanceof SelectionError && /unknown field secret/.test(e.message));
    assert.throws(() => compileSelection(User, 'address.country'), /unknown field address\.country/);
    assert.throws(() => compileSelection(User, 'id.length'), /unknown field id\.length/);
    assert.throws(() => compileSelection(User, '__proto__'), /unknown field/);
    assert.throws(() => compileSelection(t.number(), 'x'), /unknown field/);
    assert.throws(() => compileSelection(User, ' , '), /empty/);
    assert.throws(() => compileSelection(User, Array.from({ length: 65 }, () => 'id').join(',')), /at most 64/);
  });

  test('project keeps only selected fields, element-wise in arrays, and tolerates nulls', () => {
    const value = User.parse(user('7'));
    assert.deepEqual(project(value, compileSelection(User, 'id,address.city,orders.total')), { id: '7', address: { city: 'Berlin' }, orders: [{ total: 9.5 }] });
    assert.deepEqual(project({ ...value, address: null }, compileSelection(User, 'address.city')), { address: null });
  });
});

describe('selection over HTTP', () => {
  test('pick(): typed paths, canonical ?s= in the GET URL, only selected fields (validated first)', async () => {
    const { log, transport } = recording(http2Transport(server.url, { ca: testCert().cert }));
    const client = new ApueClient(api, transport);
    const picked = await client.pick('users.get', { id: '42' }, ['name', 'address.city', 'orders.items.sku']);
    assert.deepEqual(picked, { name: 'user 42', address: { city: 'Berlin' }, orders: [{ items: [{ sku: 'a' }] }] });
    assert.equal(log[0]!.method, 'GET');
    assert.match(log[0]!.path, /&s=address\.city%2Cname%2Corders\.items\.sku$/);
    const city: string | undefined = picked.address?.city;
    void city;
    // @ts-expect-error not a field of the output
    void (() => client.pick('users.get', { id: '1' }, ['secret']));
    await client.close();
  });

  test('ETag differs per selection; If-None-Match works per selection', async () => {
    const path = `/users.get?i=${encodeURIComponent('{"id":"1"}')}`;
    const full = await fetch(`${server.url}${path}`);
    const partial = await fetch(`${server.url}${path}&s=name`);
    assert.notEqual(full.headers.get('etag'), partial.headers.get('etag'));
    assert.deepEqual(await partial.json(), { name: 'user 1' });
    await full.arrayBuffer();
    const again = await fetch(`${server.url}${path}&s=name`, { headers: { 'if-none-match': partial.headers.get('etag')! } });
    assert.equal(again.status, 304);
  });

  test('QUERY, POST, streams and batches honour selections', async () => {
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    const tags = Array.from({ length: 300 }, (_, i) => `u${i}`);
    const many = await client.call('users.search', { tags }, { select: ['id'] });
    assert.equal(many.length, 300);
    assert.deepEqual(many[0], { id: 'u0' });
    assert.deepEqual(await client.pick('users.update', { id: '9' }, ['email']), { email: '9@example.com' });
    assert.deepEqual(await Array.fromAsync(client.stream('users.watch', undefined, { select: ['id', 'manager.name'] })), [
      { id: '1', manager: { name: 'The Boss' } },
      { id: '2', manager: { name: 'The Boss' } },
    ]);
    const res = await fetch(`${server.url}/$batch`, {
      method: 'POST',
      headers: { 'content-type': MediaType.JSON },
      body: JSON.stringify({ calls: [{ op: 'users.get', in: { id: 'b' }, select: 'name' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(new TextDecoder().decode(await res.arrayBuffer()), /\{"name":"user b"\}/);
    await client.close();
  });

  test('invalid selections → 400 invalid-selection before running the handler', async () => {
    for (const [path, detail] of [
      [`/users.get?i=${encodeURIComponent('{"id":"1"}')}&s=secret`, /unknown field secret/],
      ['/count?s=x', /unknown field x/],
    ] as const) {
      const res = await fetch(`${server.url}${path}`);
      const problem = await res.json();
      assert.equal(res.status, 400);
      assert.equal(problem.type, 'https://apue.dev/problems/invalid-selection');
      assert.match(problem.detail, detail);
    }
    const batch = await fetch(`${server.url}/$batch`, {
      method: 'POST',
      headers: { 'content-type': MediaType.JSON },
      body: JSON.stringify({ calls: [{ op: 'users.get', in: { id: 'b' }, select: 'nope' }] }),
    });
    assert.equal(batch.status, 400);
    await batch.arrayBuffer();
  });
});
