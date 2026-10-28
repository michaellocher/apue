// Uploads that survive a restart (uploads.persistent): content synced and its length recorded at the
// end of every request; on startup files are cut back to that length, expired and orphaned files
// removed, quotas rebuilt; one process per directory.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { startServer, testCert } from './helpers.ts';

const api = defineApi({ 'files.digest': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.string() }) });
const handlers: Handlers<typeof api> = {
  'files.digest': async ({ file }) => {
    const hash = createHash('sha256');
    for await (const chunk of file.stream()) hash.update(chunk);
    const streamed = hash.digest('hex');
    // The recorded digest (idempotency identity, file.sha256) must match what is stored.
    if (file.sha256 !== streamed) throw new Error(`recorded digest ${file.sha256} ≠ content ${streamed}`);
    return streamed;
  },
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MiB = 1024 * 1024;

function tempDir(ctx: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'apue-persist-test-'));
  ctx.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const store = (directory: string) => join(directory, 'apue-uploads');
const patch = (url: string, location: string, offset: number, complete: boolean, body: Uint8Array) =>
  fetch(`${url}${location}`, { method: 'PATCH', headers: { 'content-type': 'application/partial-upload', 'upload-offset': String(offset), 'upload-complete': complete ? '?1' : '?0' }, body: body as Uint8Array<ArrayBuffer> });
const create = async (url: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${url}/$uploads`, { method: 'POST', headers: { 'upload-complete': '?0', ...headers } });
  assert.equal(res.status, 201);
  return res.headers.get('location')!;
};
const offsetOf = async (url: string, location: string) => {
  const res = await fetch(`${url}${location}`, { method: 'HEAD' });
  return { status: res.status, offset: Number(res.headers.get('upload-offset')) };
};
const digestVia = async (url: string, id: string) => {
  const client = new ApueClient(api, http2Transport(url, { ca: testCert().cert }));
  try {
    return await client.call('files.digest', { file: { $upload: id } });
  } finally {
    await client.close();
  }
};

test('an upload in progress survives a restart: offset retrieval answers, the rest completes it', async (ctx) => {
  const directory = tempDir(ctx);
  const bytes = new Uint8Array(randomBytes(3 * MiB + 17));
  const first = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  const location = await create(first.url);
  assert.equal((await patch(first.url, location, 0, false, bytes.subarray(0, 2 * MiB + 5))).status, 204);
  await first.close();
  assert.ok(existsSync(join(store(directory), location.split('/').pop()!)), 'files stay after close()');
  assert.ok(!existsSync(join(store(directory), '.lock')), 'the lock is released');

  const second = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  ctx.after(() => second.close());
  assert.deepEqual(await offsetOf(second.url, location), { status: 204, offset: 2 * MiB + 5 });
  const done = await patch(second.url, location, 2 * MiB + 5, true, bytes.subarray(2 * MiB + 5));
  assert.equal(done.status, 201);
  // The digest continues across the restart (recomputed from the stored content).
  assert.equal(await digestVia(second.url, (await done.json()).upload), sha(bytes));
});

test('a complete upload survives a restart and is still usable as an input', async (ctx) => {
  const directory = tempDir(ctx);
  const bytes = new Uint8Array(randomBytes(MiB));
  const first = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  const client = new ApueClient(api, http2Transport(first.url, { ca: testCert().cert }));
  const ref = await client.upload(bytes);
  await client.close();
  await first.close();
  const second = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  ctx.after(() => second.close());
  assert.equal(await digestVia(second.url, ref.$upload), sha(bytes));
});

test('bytes never acknowledged are cut off on restart (content is never corrupt)', async (ctx) => {
  const directory = tempDir(ctx);
  const bytes = new Uint8Array(randomBytes(2 * MiB));
  const first = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  const location = await create(first.url);
  assert.equal((await patch(first.url, location, 0, false, bytes.subarray(0, MiB))).status, 204);
  await first.close();
  // A crash after writing but before recording the length leaves a tail like this one.
  const data = join(store(directory), location.split('/').pop()!);
  appendFileSync(data, new Uint8Array(4096).fill(0xee));
  const second = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  ctx.after(() => second.close());
  assert.equal(statSync(data).size, MiB);
  assert.deepEqual(await offsetOf(second.url, location), { status: 204, offset: MiB });
  const done = await patch(second.url, location, MiB, true, bytes.subarray(MiB));
  assert.equal(await digestVia(second.url, (await done.json()).upload), sha(bytes));
});

test('on restart: expired uploads, orphans, temporary and invalid files are removed; quotas are rebuilt', async (ctx) => {
  const directory = tempDir(ctx);
  let now = 1_000_000;
  const options = { directory, persistent: true, ttlMs: 60_000, scopeUploads: 3, now: () => now };
  const first = await startServer(api, handlers, { uploads: options });
  const old = await create(first.url);
  now += 30_000;
  const kept = [await create(first.url), await create(first.url)];
  await first.close();
  writeFileSync(join(store(directory), 'AAAAAAAAAAAAAAAAAAAAAA'), 'orphaned data'); // no metadata
  writeFileSync(join(store(directory), 'BBBBBBBBBBBBBBBBBBBBBB.json'), '{"v":1}'); // invalid metadata
  writeFileSync(join(store(directory), 'CCCCCCCCCCCCCCCCCCCCCC.json.tmp'), '{}'); // interrupted write
  writeFileSync(join(store(directory), 'not-an-upload'), 'x');
  now += 35_000; // the first upload is 65 s old now: expired; the others 35 s
  const second = await startServer(api, handlers, { uploads: options });
  ctx.after(() => second.close());
  // Checked before any request: startup itself cleans up (not the per-request expiry sweep).
  const names = readdirSync(store(directory)).sort();
  assert.deepEqual(names, [...kept.flatMap((l) => [l.split('/').pop()!, `${l.split('/').pop()}.json`]), '.lock'].sort());
  assert.equal((await offsetOf(second.url, old)).status, 404);
  for (const location of kept) assert.equal((await offsetOf(second.url, location)).status, 204);
  // The two restored uploads count against the same client's limit of 3.
  await create(second.url);
  assert.equal((await fetch(`${second.url}/$uploads`, { method: 'POST', headers: { 'upload-complete': '?0' } })).status, 507);
});

test('one process per directory: a live owner is refused, a dead owner\'s lock is taken over', async (ctx) => {
  const directory = tempDir(ctx);
  const first = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  await assert.rejects(startServer(api, handlers, { uploads: { directory, persistent: true } }), /in use by process/);
  await first.close();
  writeFileSync(join(store(directory), '.lock'), '2147483646'); // a pid no process has
  const second = await startServer(api, handlers, { uploads: { directory, persistent: true } });
  ctx.after(() => second.close());
  assert.equal(String(process.pid), (await import('node:fs')).readFileSync(join(store(directory), '.lock'), 'utf8'));
  await assert.rejects(startServer(api, handlers, { uploads: { persistent: true } as never }), /needs uploads.directory/);
});
