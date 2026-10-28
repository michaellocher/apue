// RFC 9213 CDN-Cache-Control and RFC 9875 cache groups.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { startServer } from './helpers.ts';

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: t.string(), cache: { maxAge: 60, cdnMaxAge: 3600, groups: ['users', 'team "a"'] } }),
  'users.rename': op({ effect: 'unsafe', input: t.object({ id: t.string() }), output: t.string(), invalidates: ['users'] }),
  'users.fail': op({ effect: 'unsafe', input: t.void(), output: t.string(), invalidates: ['users'] }),
});
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => id,
  'users.rename': ({ id }) => id,
  'users.fail': () => {
    throw new Error('boom');
  },
};

let server: { url: string; close(): Promise<void> };
before(async () => {
  server = await startServer(api, handlers);
});
after(() => server.close());

test('safe responses: CDN-Cache-Control for CDNs, Cache-Control for browsers, Cache-Groups as an SF list', async () => {
  const res = await fetch(`${server.url}/users.get?i=${encodeURIComponent('{"id":"1"}')}`);
  await res.arrayBuffer();
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(res.headers.get('cdn-cache-control'), 'max-age=3600');
  assert.equal(res.headers.get('cache-groups'), '"users", "team \\"a\\""');
});

test('successful non-safe responses carry Cache-Group-Invalidation; failures do not', async (t) => {
  const ok = await fetch(`${server.url}/users.rename`, { method: 'POST', headers: { 'content-type': MediaType.JSON }, body: '{"id":"1"}' });
  await ok.arrayBuffer();
  assert.equal(ok.headers.get('cache-group-invalidation'), '"users"');
  t.mock.method(console, 'error', () => {});
  const failed = await fetch(`${server.url}/users.fail`, { method: 'POST' });
  await failed.arrayBuffer();
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('cache-group-invalidation'), null);
});

test('definition-time checks follow the RFCs', () => {
  const base = { input: t.void(), output: t.void() };
  assert.throws(() => op({ effect: 'safe', ...base, invalidates: ['x'] }), /ignored on safe methods/);
  assert.throws(() => op({ effect: 'unsafe', ...base, cache: { maxAge: 1 } }), /only safe ops are cacheable/);
  assert.throws(() => op({ effect: 'safe', ...base, cache: { private: true, cdnMaxAge: 10 } }), /private/);
  assert.throws(() => op({ effect: 'safe', ...base, cache: { groups: Array.from({ length: 33 }, (_, i) => `g${i}`) } }), /at most 32/);
  assert.throws(() => op({ effect: 'safe', ...base, cache: { groups: ['x'.repeat(33)] } }), /1–32 printable ASCII/);
  assert.throws(() => op({ effect: 'unsafe', ...base, invalidates: ['ünicode'] }), /printable ASCII/);
});
