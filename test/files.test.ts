// Spike S20: t.file() — large binary inputs uploaded resumably and read by handlers as streams,
// with the upload content in files (uploads.directory), never in memory.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, fstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport, type TransportRequest } from '../src/client.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  'files.ingest': op({ effect: 'unsafe', input: t.object({ name: t.string(), file: t.file({ max: 8 * 1024 * 1024 }) }), output: t.object({ size: t.number(), sha256: t.string(), declared: t.string() }) }),
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const handlers: Handlers<typeof api> = {
  'files.ingest': async ({ file }) => {
    // The handler streams: nothing here holds the whole file.
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.stream()) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    return { size, sha256: hash.digest('hex'), declared: file.sha256 };
  },
};

describe('t.file(): definition rules', () => {
  test('inputs only, and only unary ones', () => {
    assert.throws(() => op({ effect: 'safe', input: t.void(), output: t.object({ f: t.file() }) }), /inputs only/);
    assert.throws(() => op({ effect: 'unsafe', stream: 'client', input: t.object({ f: t.file() }), output: t.void() }), /unary input/);
  });
});

for (const mode of ['files', 'memory'] as const) {
  describe(`t.file() end to end (${mode})`, () => {
    let server: { url: string; close(): Promise<void> };
    let directory: string;
    before(async () => {
      directory = mkdtempSync(join(tmpdir(), 'apue-files-test-'));
      server = await startServer(api, handlers, { uploads: { maxBytes: 16 * 1024 * 1024, ...(mode === 'files' ? { directory } : {}) } });
    });
    after(async () => {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    });

    test('a Blob and a Uint8Array reach the handler as streams with the right content and digest', async () => {
      const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
      const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024 + 7));
      for (const file of [new Blob([bytes]), bytes]) {
        const result = await client.call('files.ingest', { name: 'a', file });
        assert.deepEqual(result, { size: bytes.byteLength, sha256: sha(bytes), declared: sha(bytes) });
      }
      await client.close();
    });

    test('the size limit holds on the client (before uploading) and on the server', async () => {
      const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
      await assert.rejects(client.call('files.ingest', { name: 'big', file: new Blob([new Uint8Array(9 * 1024 * 1024)]) }), (e: ApueError) => e.status === 400);
      const ref = await client.upload(new Blob([new Uint8Array(9 * 1024 * 1024)]));
      await assert.rejects(client.call('files.ingest', { name: 'big', file: ref }), (e: ApueError) => e.status === 400 && /more than/.test(JSON.stringify(e.problem)));
      await client.close();
    });
  });
}

test('a Blob upload survives a lost connection (resumes with slice(offset), nothing buffered)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apue-files-test-'));
  const server = await startServer(api, handlers, { uploads: { maxBytes: 16 * 1024 * 1024, directory } });
  const inner = http2Transport(server.url, { ca: testCert().cert });
  let cut = false;
  const patches: TransportRequest[] = [];
  const transport: Transport = {
    async request(req) {
      if (req.method === 'PATCH') patches.push(req);
      if (req.method === 'PATCH' && !cut) {
        cut = true;
        const blob = req.body as Blob;
        // send the first 1 MiB of the Blob, then lose the connection
        const first = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
        return inner.request({
          ...req,
          body: (async function* () {
            yield first;
            await sleep(50);
            throw new Error('ECONNRESET (simulated)');
          })(),
        });
      }
      return inner.request(req);
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
  const client = new ApueClient(api, transport, { backoffMs: 1 });
  const bytes = new Uint8Array(randomBytes(4 * 1024 * 1024));
  const result = await client.call('files.ingest', { name: 'r', file: new Blob([bytes]) });
  assert.equal(result.sha256, sha(bytes));
  assert.equal(patches.length, 2);
  assert.ok(patches[1]!.body instanceof Blob, 'the resumed attempt is a slice of the Blob, not a buffered copy');
  assert.equal((patches[1]!.body as Blob).size, bytes.byteLength - 1024 * 1024);
  await client.close();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a handler writing into the chunks it streams cannot change the upload for later calls (memory store)', async (ctx) => {
  const mutating = defineApi({ 'files.digest': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.string() }) });
  const server = await startServer(mutating, {
    'files.digest': async ({ file }) => {
      const hash = createHash('sha256');
      for await (const chunk of file.stream()) {
        hash.update(chunk);
        chunk.fill(0); // a careless handler reusing the buffer
      }
      return hash.digest('hex');
    },
  }, { uploads: {} });
  const client = new ApueClient(mutating, http2Transport(server.url, { ca: testCert().cert }));
  ctx.after(async () => {
    await client.close();
    await server.close();
  });
  const bytes = new Uint8Array(randomBytes(100_000));
  const ref = await client.upload(bytes);
  assert.equal(await client.call('files.digest', { file: ref }), sha(bytes));
  assert.equal(await client.call('files.digest', { file: ref }), sha(bytes)); // same content the second time
});

test('an upload deleted while its call runs stays readable for that call; nothing stays open afterwards', async (ctx) => {
  // A second party's DELETE (or expiry) unlinks the file; the call opened it before, so it reads on.
  const directory = mkdtempSync(join(tmpdir(), 'apue-files-test-'));
  const deleting = defineApi({ 'files.late': op({ effect: 'unsafe', input: t.object({ id: t.string(), file: t.file() }), output: t.string() }) });
  let url = '';
  const server = await startServer(deleting, {
    'files.late': async ({ id, file }) => {
      const removed = await fetch(`${url}/$uploads/${id}`, { method: 'DELETE' });
      assert.equal(removed.status, 204);
      const hash = createHash('sha256');
      for await (const chunk of file.stream()) hash.update(chunk);
      return hash.digest('hex');
    },
  }, { uploads: { directory } });
  url = server.url;
  ctx.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = new ApueClient(deleting, http2Transport(server.url, { ca: testCert().cert }));
  ctx.after(() => client.close());
  const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024));
  const ref = await client.upload(bytes);
  // Open regular files of this process (sockets come and go with connections; they don't count).
  const openFiles = () =>
    readdirSync('/dev/fd').filter((fd) => {
      try {
        return fstatSync(Number(fd)).isFile();
      } catch {
        return false;
      }
    }).length;
  assert.equal(openFiles(), 0, 'a complete upload holds no descriptor');
  assert.equal(await client.call('files.late', { id: ref.$upload, file: ref }), sha(bytes));
  await sleep(50); // the release runs after the response
  assert.equal(openFiles(), 0, 'the call\'s read descriptor is closed');
  assert.deepEqual(readdirSync(join(directory, readdirSync(directory)[0]!)), []); // and the file is gone
});

test('uploads waiting for their next request hold no file descriptors (100 per client would exhaust them)', async (ctx) => {
  const directory = mkdtempSync(join(tmpdir(), 'apue-files-test-'));
  const server = await startServer(api, handlers, { uploads: { directory } });
  ctx.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const regularFiles = () => readdirSync('/dev/fd').filter((fd) => {
    try {
      return fstatSync(Number(fd)).isFile();
    } catch {
      return false;
    }
  }).length;
  const before = regularFiles();
  const locations: string[] = [];
  for (let i = 0; i < 20; i++) {
    const created = await fetch(`${server.url}/$uploads`, { method: 'POST', headers: { 'upload-complete': '?0' } });
    assert.equal(created.status, 201);
    locations.push(created.headers.get('location')!);
  }
  const partial = await fetch(`${server.url}${locations[0]}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/partial-upload', 'upload-offset': '0', 'upload-complete': '?0' },
    body: new Uint8Array(2 * 1024 * 1024 + 5), // two full write blocks and a rest
  });
  assert.equal(partial.status, 204);
  assert.equal(regularFiles(), before);
  // … and the next request writes after what is there (positional writes, a fresh handle).
  const rest = new Uint8Array(randomBytes(1000));
  const done = await fetch(`${server.url}${locations[0]}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/partial-upload', 'upload-offset': String(2 * 1024 * 1024 + 5), 'upload-complete': '?1' },
    body: rest,
  });
  assert.equal(done.status, 201);
  const id = (await done.json()).upload as string;
  const expected = sha(new Uint8Array([...new Uint8Array(2 * 1024 * 1024 + 5), ...rest]));
  assert.equal((await new ApueClient(api, http2Transport(server.url, { ca: testCert().cert })).call('files.ingest', { name: 'p', file: { $upload: id } })).sha256, expected);
});

test('closing the server removes its upload directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apue-files-test-'));
  const server = await startServer(api, handlers, { uploads: { directory } });
  const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
  await client.upload(new Blob([new Uint8Array(1000)]));
  assert.equal(readdirSync(directory).length, 1); // the per-process subdirectory
  await client.close();
  await server.close();
  assert.deepEqual(readdirSync(directory), []);
  assert.ok(existsSync(directory)); // the configured directory itself stays
  rmSync(directory, { recursive: true });
});
