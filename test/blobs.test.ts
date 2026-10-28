// Binary data: BLOB frames instead of base64, chunked, in streams, unary responses, uploads, batches.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { BLOB_CHUNK, BlobAssembler, messageFrames } from '../src/blobs.ts';
import { ApueClient } from '../src/client.ts';
import { concatBytes, decodeJson, Flag, FrameDecoder, FrameError, FrameType, encodeFrame, msgFrame, endFrame } from '../src/frame.ts';
import { MediaType } from '../src/protocol.ts';
import { containsBytes, t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { webSocketTransport } from '../src/transport-ws.ts';
import { startServer, testCert } from './helpers.ts';

const File = t.object({ name: t.string(), data: t.bytes(), thumb: t.optional(t.bytes({ max: 1024 })) });
const MiB = 1024 * 1024;
const files = [randomBytes(MiB), randomBytes(MiB + 123), new Uint8Array(0)].map((data, i) => ({ name: `f${i}`, data: new Uint8Array(data) }));

const api = defineApi({
  'files.list': op({ effect: 'safe', stream: 'server', input: t.void(), output: File }),
  'files.get': op({ effect: 'safe', input: t.object({ i: t.number() }), output: File }),
  'files.put': op({ effect: 'unsafe', stream: 'client', input: File, output: t.object({ count: t.number(), bytes: t.number() }) }),
  'files.echo': op({ effect: 'unsafe', stream: 'bidi', input: File, output: File }),
  'plain.sum': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'files.render': op({ effect: 'unsafe', input: t.object({ name: t.string() }), output: File }),
});
let renders = 0;
const handlers: Handlers<typeof api> = {
  'files.list': async function* () {
    yield* files;
  },
  'files.get': ({ i }) => files[i]!,
  'files.put': async (inputs) => {
    let count = 0;
    let bytes = 0;
    for await (const file of inputs) {
      count++;
      bytes += file.data.byteLength;
    }
    return { count, bytes };
  },
  'files.echo': async function* (inputs) {
    for await (const file of inputs) yield file;
  },
  'files.render': ({ name }) => ({ name, data: new Uint8Array(70_000).fill(++renders) }),
  'plain.sum': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
};

let server: { url: string; close(): Promise<void> };
before(async () => {
  server = await startServer(api, handlers, { maxBodyBytes: 4 * MiB }); // blobs count against the body budget
});
after(() => server.close());

const same = (a: { name: string; data: Uint8Array }, b: { name: string; data: Uint8Array }) => a.name === b.name && Buffer.from(a.data).equals(Buffer.from(b.data));

describe('blob codec', () => {
  test('round trip: several blobs, empty blob, chunking, look-alike data stays verbatim', () => {
    const big = new Uint8Array(BLOB_CHUNK * 2 + 5).map((_, i) => i % 251);
    const value = { a: big, list: [new Uint8Array([1, 2]), new Uint8Array(0)], fake: { $blob: 0 }, lit: { $lit: 'x' }, n: 1 };
    const frames = messageFrames(value, 3);
    assert.equal(frames.length, 3 + 1 + 1 + 1); // 3 chunks for big, 1 each for the others, MSG
    const decoder = new FrameDecoder();
    const assembler = new BlobAssembler();
    let result: unknown;
    for (const frame of decoder.push(concatBytes(frames))) {
      assert.equal(frame.lane, 3);
      if (frame.type === FrameType.BLOB) assembler.push(frame);
      else result = assembler.resolve(decodeJson(frame.payload), 3);
    }
    const r = result as typeof value;
    assert.ok(Buffer.from(r.a).equals(Buffer.from(big)));
    assert.deepEqual(r.list.map((b) => Array.from(b)), [[1, 2], []]);
    assert.deepEqual([r.fake, r.lit, r.n], [{ $blob: 0 }, { $lit: 'x' }, 1]);
  });

  test('protocol errors: MSG inside an unfinished blob, unreferenced or invalid references, size limit', () => {
    const blob = (lane: number, flags: number, bytes = [1]) => ({ type: FrameType.BLOB, flags, lane, payload: new Uint8Array(bytes) });
    const a = new BlobAssembler();
    a.push(blob(0, 0));
    assert.throws(() => a.resolve({ x: { $blob: 0 } }), FrameError);
    const b = new BlobAssembler();
    b.push(blob(0, Flag.LAST));
    assert.throws(() => b.resolve({ x: 1 }), /references 0 of 1/);
    const c = new BlobAssembler();
    c.push(blob(0, Flag.LAST));
    assert.throws(() => c.resolve({ x: { $blob: 1 } }), /invalid blob reference/);
    const d = new BlobAssembler(4);
    assert.throws(() => d.push(blob(0, Flag.LAST, [1, 2, 3, 4, 5])), /exceed/);
  });

  test('schemas: t.bytes(), containsBytes, unary inputs with bytes are refused at definition time', () => {
    assert.throws(() => t.bytes().parse('AAEC'), /expected bytes/);
    assert.throws(() => t.bytes({ max: 1 }).parse(new Uint8Array(2)), /more than 1 bytes/);
    assert.ok(containsBytes(File) && containsBytes(t.array(File)) && !containsBytes(t.object({ a: t.string() })));
    assert.throws(() => op({ effect: 'unsafe', input: File, output: t.void() }), /need a request stream/);
  });
});

describe('blobs end to end', () => {
  test('server stream of 1 MiB files: exact bytes, < 1 % wire overhead (no base64)', async () => {
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert, acceptEncoding: '' }));
    const got = await Array.fromAsync(client.stream('files.list'));
    assert.equal(got.length, 3);
    for (const [i, file] of got.entries()) assert.ok(same(file, files[i]!), `file ${i}`);
    const session = http2.connect(server.url, { ca: testCert().cert });
    const wire = await new Promise<number>((resolve, reject) => {
      const req = session.request({ ':path': '/files.list', accept: MediaType.STREAM_JSON });
      let n = 0;
      req.on('data', (chunk: Buffer) => (n += chunk.byteLength));
      req.on('end', () => resolve(n));
      req.on('error', reject);
      req.end();
    });
    session.close();
    const payload = files.reduce((sum, f) => sum + f.data.byteLength, 0);
    assert.ok(wire < payload * 1.01, `wire ${wire} vs payload ${payload}`);
    await client.close();
  });

  test('unary op with bytes output: call() returns Uint8Array (framed response)', async () => {
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    const file = await client.call('files.get', { i: 1 });
    assert.ok(file.data instanceof Uint8Array && same(file, files[1]!));
    await client.close();
  });

  for (const [name, transport] of [
    ['http2', () => http2Transport(server.url, { ca: testCert().cert })],
    ['WebSocket', () => webSocketTransport(server.url)],
  ] as const) {
    test(`client-stream upload and bidi echo with blobs over ${name}`, async () => {
      const client = new ApueClient(api, transport());
      async function* upload() {
        yield* files;
      }
      assert.deepEqual(await Array.fromAsync(client.duplex('files.put', upload())), [{ count: 3, bytes: 2 * MiB + 123 }]);
      const echoed = await Array.fromAsync(client.duplex('files.echo', upload()));
      assert.ok(echoed.every((file, i) => same(file, files[i]!)));
      await client.close?.();
    });
  }

  test('request-stream blobs: over the body budget → 413, lanes other than 0 → 400 (review finding)', async () => {
    const big = new Uint8Array(5 * MiB);
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    async function* tooBig() {
      yield { name: 'big', data: big };
    }
    await assert.rejects(Array.fromAsync(client.duplex('files.put', tooBig())), (e: { status: number }) => e.status === 413);
    await client.close();
    const res = await fetch(`${server.url}/files.put`, {
      method: 'POST',
      headers: { 'content-type': MediaType.STREAM_JSON },
      body: concatBytes([encodeFrame(FrameType.BLOB, new Uint8Array([1]), 7, 0)]) as Uint8Array<ArrayBuffer>,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).detail, /lane 7/);
  });

  test('unsafe op with bytes output: an Idempotency-Key replays the stored bytes (review finding)', async () => {
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    const before = renders;
    const first = await client.call('files.render', { name: 'r' }, { idempotencyKey: 'render-1' });
    const again = await client.call('files.render', { name: 'r' }, { idempotencyKey: 'render-1' });
    assert.equal(renders, before + 1); // executed once
    assert.ok(again.data instanceof Uint8Array);
    assert.ok(same(again, first));
    assert.equal(again.data[0], first.data[0]);
    const raw = await fetch(`${server.url}/files.render`, {
      method: 'POST',
      headers: { 'content-type': MediaType.JSON, 'idempotency-key': '"render-1"' },
      body: JSON.stringify({ name: 'r' }),
    });
    assert.equal(raw.headers.get('apue-replayed'), '?1');
    assert.equal(raw.headers.get('content-type'), MediaType.STREAM_JSON);
    await raw.arrayBuffer();
    await client.close();
  });

  test('batch lanes carry blobs; BLOB frames on a non-bytes op are a 400', async () => {
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    const batch = client.batch();
    const a = batch.call('files.get', { i: 0 });
    const b = batch.call('files.get', { i: 2 });
    await batch.send();
    assert.ok(same(await a.result, files[0]!) && same(await b.result, files[2]!));
    await client.close();
    const res = await fetch(`${server.url}/plain.sum`, {
      method: 'POST',
      headers: { 'content-type': MediaType.STREAM_JSON },
      body: concatBytes([encodeFrame(FrameType.BLOB, new Uint8Array([1]), 0, Flag.LAST), msgFrame(1), endFrame({ status: 200 })]) as Uint8Array<ArrayBuffer>,
    });
    assert.equal(res.status, 400);
    await res.arrayBuffer();
  });
});
