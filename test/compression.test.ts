// Response compression: negotiation, unary and streaming, ETags, TTFB with per-burst flush.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import zlib from 'node:zlib';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { createDecompressor, negotiate, type Coding } from '../src/compression.ts';
import { decodeFrames, decodeJson, FrameType } from '../src/frame.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const big = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `customer ${i}`, email: `c${i}@example.com` }));
const Row = t.object({ id: t.number(), name: t.string(), email: t.string() });

const api = defineApi({
  'big.get': op({ effect: 'safe', input: t.void(), output: t.array(Row) }),
  'small.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'slow.stream': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.string() }),
  'ticker': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
});

let cancelled: PromiseWithResolvers<void>;
const handlers: Handlers<typeof api> = {
  'big.get': () => big,
  'small.get': () => 'tiny',
  'slow.stream': async function* () {
    yield 'first';
    await sleep(300);
    yield 'second';
  },
  'ticker': async function* (_input, ctx) {
    ctx.signal.addEventListener('abort', () => cancelled.resolve());
    for (let i = 0; ; i++) {
      yield i;
      await sleep(5);
    }
  },
};

let server: { url: string; close(): Promise<void> };
let plain: { url: string; close(): Promise<void> };
let session: http2.ClientHttp2Session;
before(async () => {
  server = await startServer(api, handlers);
  plain = await startServer(api, handlers, { compression: false });
  session = http2.connect(server.url, { ca: testCert().cert });
});
after(async () => {
  session.close();
  await server.close();
  await plain.close();
});

interface RawResponse {
  headers: http2.IncomingHttpHeaders;
  body: Buffer;
}

function raw(path: string, headers: Record<string, string> = {}, target = session): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = target.request({ ':path': path, ...headers });
    const chunks: Buffer[] = [];
    let responseHeaders: http2.IncomingHttpHeaders = {};
    req.on('response', (h) => (responseHeaders = h));
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve({ headers: responseHeaders, body: Buffer.concat(chunks) }));
    req.on('error', reject);
    req.end();
  });
}

function decompress(coding: string, body: Buffer): Buffer {
  if (coding === 'zstd') return zlib.zstdDecompressSync(body);
  if (coding === 'br') return zlib.brotliDecompressSync(body);
  return zlib.gunzipSync(body);
}

describe('negotiation', () => {
  test('server preference among equals, q-values, q=0 and *', () => {
    assert.equal(negotiate(undefined), undefined);
    assert.equal(negotiate(''), undefined);
    assert.equal(negotiate('gzip, br, zstd'), 'zstd');
    assert.equal(negotiate('gzip, deflate, br'), 'br');
    assert.equal(negotiate('gzip'), 'gzip');
    assert.equal(negotiate('identity'), undefined);
    assert.equal(negotiate('zstd;q=0.5, gzip;q=0.9'), 'gzip');
    assert.equal(negotiate('zstd;q=0, br;q=0, *'), 'gzip');
    assert.equal(negotiate('*;q=0'), undefined);
    assert.equal(negotiate('ZSTD;Q=1'), 'zstd');
    assert.equal(negotiate('zstd;q=2, gzip'), 'gzip'); // invalid q ignored
    assert.equal(negotiate('zstd, br', ['gzip']), undefined);
  });
});

describe('unary responses', () => {
  for (const coding of ['zstd', 'br', 'gzip'] satisfies Coding[]) {
    test(`${coding}: compressed, content-length of the encoded body, Vary, ETag per coding, 304`, async () => {
      const res = await raw('/big.get', { 'accept-encoding': coding });
      assert.equal(res.headers['content-encoding'], coding);
      assert.equal(Number(res.headers['content-length']), res.body.byteLength);
      assert.match(String(res.headers.vary), /accept-encoding/);
      assert.ok(res.body.byteLength < JSON.stringify(big).length / 3, `${coding}: ${res.body.byteLength} bytes`);
      assert.deepEqual(JSON.parse(decompress(coding, res.body).toString()), big);
      const etag = String(res.headers.etag);
      assert.match(etag, new RegExp(`-${coding}"$`));
      const again = await raw('/big.get', { 'accept-encoding': coding, 'if-none-match': etag });
      assert.equal(again.headers[':status'], 304);
      const head = await raw('/big.get', { 'accept-encoding': coding }, session);
      assert.equal(head.headers['content-length'], res.headers['content-length']);
    });
  }

  test('identity when not accepted; ETags differ between codings', async () => {
    const identity = await raw('/big.get');
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(identity.body.toString()), big);
    const zstd = await raw('/big.get', { 'accept-encoding': 'zstd' });
    assert.notEqual(identity.headers.etag, zstd.headers.etag);
    const cross = await raw('/big.get', { 'accept-encoding': 'zstd', 'if-none-match': String(identity.headers.etag) });
    assert.equal(cross.headers[':status'], 200);
  });

  test('HEAD reports the encoded length', async () => {
    const get = await raw('/big.get', { 'accept-encoding': 'br' });
    const head = await raw('/big.get', { 'accept-encoding': 'br', ':method': 'HEAD' });
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.body.byteLength, 0);
  });

  test('small bodies are not compressed and do not Vary', async () => {
    const res = await raw('/small.get', { 'accept-encoding': 'zstd' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers.vary, undefined);
  });

  test('compression: false disables it', async () => {
    const other = http2.connect(plain.url, { ca: testCert().cert });
    const res = await raw('/big.get', { 'accept-encoding': 'zstd' }, other);
    other.close();
    assert.equal(res.headers['content-encoding'], undefined);
  });
});

describe('streams', () => {
  for (const coding of ['zstd', 'br', 'gzip'] satisfies Coding[]) {
    test(`${coding}: each frame burst is flushed — first message arrives before the stream ends`, async () => {
      const started = performance.now();
      const req = session.request({ ':path': '/slow.stream', 'accept-encoding': coding, accept: MediaType.STREAM_JSON });
      req.end();
      const headers = await new Promise<http2.IncomingHttpHeaders>((resolve) => req.once('response', resolve));
      assert.equal(headers['content-encoding'], coding);
      const decompressor = createDecompressor(coding)!;
      req.pipe(decompressor);
      const arrivals: Array<[unknown, number]> = [];
      for await (const frame of decodeFrames(decompressor)) {
        if (frame.type === FrameType.MSG) arrivals.push([decodeJson(frame.payload), performance.now() - started]);
      }
      assert.deepEqual(arrivals.map(([value]) => value), ['first', 'second']);
      assert.ok(arrivals[0]![1] < 200, `first message after ${arrivals[0]![1].toFixed(0)} ms`);
      assert.ok(arrivals[1]![1] >= 280);
    });
  }

  test('typed client decompresses every coding (http2 transport)', async () => {
    for (const acceptEncoding of ['zstd', 'br', 'gzip', '']) {
      const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert, acceptEncoding }));
      assert.deepEqual(await client.call('big.get'), big);
      assert.deepEqual(await Array.fromAsync(client.stream('slow.stream')), ['first', 'second']);
      const batch = client.batch();
      const a = batch.call('big.get');
      const b = batch.call('small.get');
      await batch.send();
      assert.deepEqual([await a.result, await b.result], [big, 'tiny']);
      await client.close();
    }
  });

  test('cancelling a compressed stream still reaches the handler', async () => {
    cancelled = Promise.withResolvers();
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert, acceptEncoding: 'zstd' }));
    for await (const n of client.stream('ticker')) if (n === 3) break;
    await cancelled.promise;
    await client.close();
  });
});
