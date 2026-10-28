// t.download() outputs (research/11 §3): the output carries a reference to a short-lived download
// resource; GET/HEAD there with Range/If-Range/ETag/Repr-Digest; clients get a Download that
// resumes a lost connection where it stopped.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport, type TransportRequest } from '../src/client.ts';
import { Download } from '../src/download.ts';
import { download, parseRange } from '../src/downloads.ts';
import { ApueError } from '../src/protocol.ts';
import { t, type DownloadSource } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { startServer, testCert } from './helpers.ts';

const MiB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const content = new Uint8Array(randomBytes(3 * MiB + 123));
let fileSource: () => Promise<DownloadSource> = () => download.fromFile('/nonexistent');

const api = defineApi({
  'export.bytes': op({ effect: 'safe', input: t.void(), output: t.object({ name: t.string(), archive: t.download({ type: 'application/zip' }) }) }),
  'export.file': op({ effect: 'safe', input: t.void(), output: t.download() }),
  'export.many': op({ effect: 'safe', stream: 'server', input: t.object({ n: t.number() }), output: t.object({ i: t.number(), part: t.download() }) }),
  'export.optional': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.optional(t.download()) }) }),
  'export.corrupt': op({ effect: 'safe', input: t.void(), output: t.download() }),
  'export.create': op({ effect: 'unsafe', input: t.object({ name: t.string() }), output: t.object({ n: t.number(), file: t.download() }) }),
});
let created = 0;
const handlers: Handlers<typeof api> = {
  'export.bytes': () => ({ name: 'backup', archive: download.fromBytes(content, { type: 'application/zip', filename: 'Backup ü.zip' }) }),
  'export.file': () => fileSource(),
  'export.many': async function* ({ n }) {
    for (let i = 0; i < n; i++) yield { i, part: download.fromBytes(new Uint8Array([i, i, i])) };
  },
  'export.optional': () => ({}),
  'export.create': ({ name }) => ({ n: ++created, file: download.fromBytes(new TextEncoder().encode(name)) }),
  // Announces the digest of other content: a corrupted store, a bug, a tampering intermediary.
  'export.corrupt': () => ({ ...download.fromBytes(new Uint8Array(1000)), sha256: sha(new Uint8Array(1000).fill(1)) }),
};

describe('definition rules', () => {
  test('outputs only; no cache max-age (download URLs expire)', () => {
    assert.throws(() => op({ effect: 'unsafe', input: t.object({ d: t.download() }), output: t.void() }), /outputs only/);
    assert.throws(() => op({ effect: 'safe', input: t.void(), output: t.download(), cache: { maxAge: 60 } }), /cannot have cache maxAge/);
    assert.doesNotThrow(() => op({ effect: 'safe', input: t.void(), output: t.download(), cache: { private: true } }));
  });

  test('Range parsing (RFC 9110 §14.1.2): one range; several or invalid are ignored', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=90-1000', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
    for (const ignored of ['bytes=0-1,5-6', 'bytes=5-1', 'items=0-1', 'bytes=-', 'bytes=a-b', undefined]) assert.equal(parseRange(ignored, 100), undefined, String(ignored));
  });
});

describe('over the wire', () => {
  const setup = async (ctx: { after(fn: () => unknown): void }, options = {}) => {
    const server = await startServer(api, handlers, options);
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    ctx.after(async () => {
      await client.close();
      await server.close();
    });
    return { server, client };
  };

  test('the client gets a Download: absolute URL, metadata, verified content', async (ctx) => {
    const { server, client } = await setup(ctx);
    const out = await client.call('export.bytes');
    assert.equal(out.name, 'backup');
    assert.ok(out.archive instanceof Download);
    assert.match(out.archive.url, new RegExp(`^${server.url}/\\$downloads/[A-Za-z0-9_-]{22}$`));
    assert.equal(out.archive.size, content.byteLength);
    assert.equal(out.archive.type, 'application/zip');
    assert.equal(out.archive.sha256, sha(content));
    const minutes = (out.archive.expires.getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 14 && minutes <= 15, `${minutes}`);
    assert.equal(sha(await out.archive.bytes()), sha(content));
    assert.equal((await out.archive.blob()).size, content.byteLength);
    assert.deepEqual(await client.call('export.optional'), {}); // absent: nothing registered
  });

  test('GET/HEAD semantics: 200, 206, 416, If-Range, If-None-Match, Repr-Digest, Content-Disposition', async (ctx) => {
    const { server, client } = await setup(ctx);
    const { archive } = await client.call('export.bytes');
    const full = await fetch(archive.url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), String(content.byteLength));
    assert.equal(full.headers.get('content-type'), 'application/zip');
    assert.equal(full.headers.get('repr-digest'), `sha-256=:${Buffer.from(sha(content), 'hex').toString('base64')}:`);
    assert.equal(full.headers.get('content-disposition'), `attachment; filename="Backup _.zip"; filename*=UTF-8''Backup%20%C3%BC.zip`);
    assert.match(full.headers.get('cache-control')!, /^private, max-age=\d+, immutable$/);
    const etag = full.headers.get('etag')!;
    assert.equal(sha(new Uint8Array(await full.arrayBuffer())), sha(content));

    const part = await fetch(archive.url, { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${content.byteLength}`);
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), content.subarray(10, 20));
    const tail = await fetch(archive.url, { headers: { range: 'bytes=-5', 'if-range': etag } });
    assert.equal(tail.status, 206);
    assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), content.subarray(-5));
    const beyond = await fetch(archive.url, { headers: { range: `bytes=${content.byteLength}-` } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${content.byteLength}`);
    await beyond.arrayBuffer();
    const otherVersion = await fetch(archive.url, { headers: { range: 'bytes=10-19', 'if-range': '"something-else"' } });
    assert.equal(otherVersion.status, 200); // If-Range mismatch: the whole content
    await otherVersion.arrayBuffer();
    const several = await fetch(archive.url, { headers: { range: 'bytes=0-1,5-6' } });
    assert.equal(several.status, 200);
    await several.arrayBuffer();
    assert.equal((await fetch(archive.url, { headers: { 'if-none-match': etag } })).status, 304);
    const head = await fetch(archive.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(content.byteLength));
    assert.equal((await fetch(archive.url, { method: 'POST' })).status, 405);
    const unknown = await fetch(`${server.url}/$downloads/AAAAAAAAAAAAAAAAAAAAAA`);
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).detail, /unknown or expired/);
  });

  test('URLs expire', async (ctx) => {
    const { client } = await setup(ctx, { downloads: { ttlMs: 50 } });
    const { archive } = await client.call('export.bytes');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(archive.bytes(), (e: ApueError) => e.status === 404);
  });

  test('a lost connection resumes with Range + If-Range (no restart), content verified', async (ctx) => {
    const server = await startServer(api, handlers);
    const inner = http2Transport(server.url, { ca: testCert().cert });
    const requests: TransportRequest[] = [];
    let cut = false;
    const transport: Transport = {
      baseUrl: server.url,
      async request(req) {
        requests.push(req);
        const res = await inner.request(req);
        if (req.method !== 'GET' || !req.path.startsWith('/$downloads/') || cut) return res;
        cut = true;
        return {
          ...res,
          body: (async function* () {
            let n = 0;
            for await (const chunk of res.body) {
              yield chunk;
              if ((n += chunk.byteLength) > MiB) throw new Error('ECONNRESET (simulated)');
            }
          })(),
        };
      },
      close: () => inner.close?.() ?? Promise.resolve(),
    };
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    ctx.after(async () => {
      await client.close();
      await server.close();
    });
    const { archive } = await client.call('export.bytes');
    const chunks: Uint8Array[] = [];
    for await (const chunk of archive.stream()) chunks.push(chunk);
    assert.equal(sha(Buffer.concat(chunks)), sha(content));
    const gets = requests.filter((r) => r.path.startsWith('/$downloads/'));
    assert.equal(gets.length, 2);
    assert.match(gets[1]!.headers.range!, /^bytes=\d+-$/);
    assert.ok(Number(/=(\d+)-/.exec(gets[1]!.headers.range!)![1]) > MiB, 'resumed after what arrived, not from 0');
    assert.match(gets[1]!.headers['if-range']!, /^"[A-Za-z0-9_-]{22}"$/);
  });

  test('a file source: streamed from disk; a file changed after it was offered fails instead of mixing', async (ctx) => {
    const directory = mkdtempSync(join(tmpdir(), 'apue-download-test-'));
    ctx.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'export.bin');
    writeFileSync(path, content);
    fileSource = () => download.fromFile(path, { type: 'application/octet-stream' });
    const { client } = await setup(ctx);
    const first = await client.call('export.file');
    assert.equal(first.sha256, undefined); // not computed for files unless given
    assert.equal(sha(await first.bytes()), sha(content));
    ctx.mock.method(console, 'error', () => {});
    writeFileSync(path, content.subarray(0, 1000)); // changed
    const res = await fetch(first.url);
    assert.equal(res.status, 500);
    await res.arrayBuffer();
  });

  test('server streams and batches carry downloads too', async (ctx) => {
    const { client } = await setup(ctx);
    const parts = await Array.fromAsync(client.stream('export.many', { n: 3 }));
    assert.deepEqual(await Promise.all(parts.map(async ({ i, part }) => [i, [...(await part.bytes())]])), [[0, [0, 0, 0]], [1, [1, 1, 1]], [2, [2, 2, 2]]]);
    const batch = client.batch();
    const one = batch.call('export.bytes');
    await batch.send();
    const { archive } = await one.result;
    assert.ok(archive instanceof Download);
    assert.equal(archive.size, content.byteLength);
  });

  test('content that doesn\'t match its announced SHA-256 is rejected (bytes(): WebCrypto; stream(): in Node)', async (ctx) => {
    const { client } = await setup(ctx);
    const corrupt = await client.call('export.corrupt');
    await assert.rejects(corrupt.bytes(), (e: ApueError) => e.status === 502 && /SHA-256/.test(e.message + JSON.stringify(e.problem)));
    await assert.rejects(Array.fromAsync(corrupt.stream()), (e: ApueError) => e.status === 502);
  });

  test('an Idempotency-Key replay refreshes its download URLs; once they expired it is a 410, never a second run', async (ctx) => {
    const { client } = await setup(ctx, { downloads: { ttlMs: 300 } });
    const before = created;
    const first = await client.call('export.create', { name: 'a' }, { idempotencyKey: 'k-download' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const replay = await client.call('export.create', { name: 'a' }, { idempotencyKey: 'k-download' });
    assert.equal(created, before + 1, 'the replay did not run the operation');
    assert.equal(replay.n, first.n);
    assert.equal(replay.file.url, first.file.url);
    assert.ok(replay.file.expires.getTime() > first.file.expires.getTime(), 'expiry refreshed');
    await new Promise((resolve) => setTimeout(resolve, 200)); // beyond the first expiry, within the refreshed one
    assert.equal(new TextDecoder().decode(await replay.file.bytes()), 'a');
    await new Promise((resolve) => setTimeout(resolve, 350)); // now expired
    await assert.rejects(client.call('export.create', { name: 'a' }, { idempotencyKey: 'k-download' }), (e: ApueError) => e.status === 410 && e.problem.type === 'https://apue.dev/problems/download-expired');
    assert.equal(created, before + 1, 'still not run again');
  });
});
