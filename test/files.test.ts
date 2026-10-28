// Spike S20: t.file() — large binary inputs uploaded resumably and read by handlers as streams,
// with the upload content in files (uploads.directory), never in memory.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
