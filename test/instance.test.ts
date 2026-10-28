// Replica routing: with `instance`, upload and download ids carry the replica's name, so a load
// balancer can route their URLs to the replica that holds them (docs/deployment.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { createApueServer } from '../src/server.ts';
import { download } from '../src/downloads.ts';
import { t } from '../src/schema.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { startServer, testCert } from './helpers.ts';

const api = defineApi({
  'files.size': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.number() }),
  'export.get': op({ effect: 'safe', input: t.void(), output: t.download() }),
});
const handlers = { 'files.size': ({ data }: { data: Uint8Array }) => data.byteLength, 'export.get': () => download.fromBytes(new Uint8Array([1, 2, 3])) };

test('ids carry the instance prefix; uploads, references and downloads work through it', async (ctx) => {
  const server = await startServer(api, handlers, { uploads: {}, instance: 'eu-1' });
  const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
  ctx.after(async () => {
    await client.close();
    await server.close();
  });
  const ref = await client.upload(new Uint8Array(1000));
  assert.match(ref.$upload, /^eu-1\.[A-Za-z0-9_-]{22}$/);
  assert.equal(await client.call('files.size', { data: ref }), 1000);
  assert.equal(await client.call('files.size', { data: new Uint8Array(7) }), 7); // automatic upload, prefixed location accepted
  const exported = await client.call('export.get');
  assert.match(exported.url, /\/\$downloads\/eu-1\.[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([...(await exported.bytes())], [1, 2, 3]);
  const head = await fetch(`${server.url}/$uploads/${ref.$upload}`, { method: 'HEAD' });
  assert.equal(head.status, 204);
});

test('instance names are validated (they become part of URLs)', () => {
  for (const instance of ['', 'a.b', 'x'.repeat(33), 'a/b', 'ü']) {
    assert.throws(() => createApueServer(api, handlers, { ...testCert(), uploads: {}, instance }), RangeError, instance);
  }
});
