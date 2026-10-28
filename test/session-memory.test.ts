// A large upload cut mid-body and resumed on the same HTTP/2 connection (found by the WAN upload
// benchmark, bench/uploads-wan.ts): the cut body had been handed to node:http2 in one 16 MiB write;
// what was still queued for the dead stream kept counting against the client session's memory limit
// (maxSessionMemory, 10 MB by default), so the resumed PATCH — and from then on every new stream on
// that connection, even HEAD — was refused with ENHANCE_YOUR_CALM. Bodies are now written in slices.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport } from '../src/client.ts';
import { t } from '../src/schema.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const MiB = 1024 * 1024;
const api = defineApi({ 'files.digest': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.string() }) });

test('a 32 MiB upload cut half way resumes on the same connection', async (ctx) => {
  // The file-backed store consumes more slowly than memory: more of the cut body is still queued.
  const directory = mkdtempSync(join(tmpdir(), 'apue-session-memory-'));
  ctx.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = await startServer(api, {
    'files.digest': async ({ file }) => {
      const hash = createHash('sha256');
      for await (const chunk of file.stream()) hash.update(chunk);
      return hash.digest('hex');
    },
  }, { uploads: { maxBytes: 64 * MiB, storeBytes: 256 * MiB, scopeBytes: 256 * MiB, directory } });
  const inner = http2Transport(server.url, { ca: testCert().cert });
  let cut = false;
  const cutting: Transport = {
    async request(req) {
      if (req.method !== 'PATCH' || cut || !(req.body instanceof Uint8Array)) return inner.request(req);
      cut = true;
      const body = req.body;
      return inner.request({
        ...req,
        body: (async function* () {
          yield body.subarray(0, body.byteLength / 2); // half the content, then the connection is "lost"
          throw new Error('ECONNRESET (simulated cut)');
        })(),
      });
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
  const client = new ApueClient(api, cutting, { backoffMs: 1 });
  ctx.after(async () => {
    await client.close();
    await server.close();
  });
  const bytes = new Uint8Array(randomBytes(32 * MiB));
  const ref = await client.upload(bytes);
  assert.ok(cut, 'the upload was cut');
  assert.equal(await client.call('files.digest', { file: ref }), createHash('sha256').update(bytes).digest('hex'));
});

// The same at the transport, deterministically: a peer that never reads the body leaves all of it
// beyond the flow-control window queued on the client; the request is then aborted.
for (const kind of ['Uint8Array', 'AsyncIterable'] as const) {
  test(`an aborted 16 MiB ${kind} body does not block later streams on the connection`, async (ctx) => {
    const { key, cert } = testCert();
    const server = http2.createSecureServer({ key, cert });
    server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
      stream.on('error', () => {});
      if (headers[':path'] === '/stall') return; // never reads, never answers
      stream.respond({ ':status': 204 });
      stream.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const transport = http2Transport(`https://localhost:${(server.address() as { port: number }).port}`, { ca: cert });
    ctx.after(async () => {
      await transport.close?.();
      await new Promise((resolve) => server.close(resolve));
    });
    const bytes = new Uint8Array(16 * MiB);
    const abort = new AbortController();
    const stalled = transport.request({
      method: 'POST',
      path: '/stall',
      headers: {},
      body: kind === 'Uint8Array' ? bytes : (async function* () { yield bytes; })(),
      signal: abort.signal,
    });
    stalled.catch(() => {});
    await sleep(100);
    abort.abort();
    await assert.rejects(stalled);
    for (let i = 0; i < 3; i++) {
      const res = await transport.request({ method: 'GET', path: '/ok', headers: {}, signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 204);
    }
  });
}
