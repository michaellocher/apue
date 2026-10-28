// HTTP/1.1 fallback (ALPN http/1.1): streams, batches and request streams must work too.
import assert from 'node:assert/strict';
import https from 'node:https';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { concatBytes, decodeFrames, decodeJson, endFrame, FrameType, msgFrame } from '../src/frame.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { startServer, testCert } from './helpers.ts';

const api = defineApi({
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number() }), output: t.number() }),
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: t.object({ id: t.string() }) }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
});
const handlers: Handlers<typeof api> = {
  'count.up': async function* ({ to }) {
    for (let i = 1; i <= to; i++) yield i;
  },
  'users.get': ({ id }) => ({ id }),
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
};

let server: { url: string; close(): Promise<void> };
before(async () => {
  server = await startServer(api, handlers);
});
after(() => server.close());

function h1(method: string, path: string, headers: Record<string, string>, body?: Uint8Array): Promise<{ version: string; status: number; type: string; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const req = https.request(`${server.url}${path}`, { method, headers, ca: testCert().cert, agent: new https.Agent({ ca: testCert().cert, keepAlive: false }) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ version: res.httpVersion, status: res.statusCode!, type: String(res.headers['content-type']), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function frames(bytes: Uint8Array) {
  return (await Array.fromAsync(decodeFrames((async function* () { yield bytes; })()))).map((f) => [f.type, f.lane, decodeJson(f.payload)]);
}

describe('HTTP/1.1', () => {
  test('server stream (chunked transfer, frames intact)', async () => {
    const res = await h1('GET', `/count.up?i=${encodeURIComponent('{"to":3}')}`, { accept: MediaType.STREAM_JSON });
    assert.equal(res.version, '1.1');
    assert.equal(res.type, MediaType.STREAM_JSON);
    assert.deepEqual(await frames(res.body), [[FrameType.MSG, 0, 1], [FrameType.MSG, 0, 2], [FrameType.MSG, 0, 3], [FrameType.END, 0, { status: 200 }]]);
  });

  test('pipelined batch', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ calls: [{ op: 'users.get', in: { id: 'a' } }, { op: 'users.get', in: { id: { $ref: [0, 'id'] } } }] }));
    const res = await h1('POST', '/$batch', { 'content-type': MediaType.JSON }, body);
    assert.equal(res.version, '1.1');
    const got = await frames(res.body);
    assert.deepEqual(got.filter(([type]) => type === FrameType.MSG).map(([, lane, value]) => [lane, value]).sort(), [[0, { id: 'a' }], [1, { id: 'a' }]]);
  });

  test('client stream (framed request body)', async () => {
    const body = concatBytes([msgFrame(20), msgFrame(22), endFrame({ status: 200 })]);
    const res = await h1('POST', '/sum.client', { 'content-type': MediaType.STREAM_JSON }, body);
    assert.equal(res.version, '1.1');
    assert.equal(res.status, 200);
    assert.deepEqual(decodeJson(res.body), 42);
  });
});
