// Resumable uploads (draft-ietf-httpbis-resumable-upload-14, research/06) and upload references in
// op inputs. Wire-level: raw node:http2 requests, so every header is under the test's control.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const MiB = 1024 * 1024;
const api = defineApi({
  'files.store': op({
    effect: 'unsafe',
    input: t.object({ name: t.string(), data: t.bytes(), thumb: t.optional(t.bytes()) }),
    output: t.object({ name: t.string(), size: t.number(), sha256: t.string() }),
  }),
});
let executions = 0;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const handlers: Handlers<typeof api> = {
  'files.store': ({ name, data }) => {
    executions++;
    return { name, size: data.byteLength, sha256: sha(data) };
  },
};

let now = 1_000_000;
let server: { url: string; close(): Promise<void> };
before(async () => {
  server = await startServer(api, handlers, { uploads: { maxBytes: 4 * MiB, storeBytes: 10 * MiB, ttlMs: 60_000, now: () => now } });
});
after(() => server.close());

interface Reply {
  status: number;
  headers: http2.IncomingHttpHeaders;
  body: Buffer;
  interim: http2.IncomingHttpHeaders[];
}

function request(method: string, path: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(server.url, { ca: testCert().cert });
    session.on('error', reject);
    const req = session.request({ ':method': method, ':path': path, ...headers }, { endStream: body === undefined });
    const interim: http2.IncomingHttpHeaders[] = [];
    let response: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    req.on('headers', (h) => interim.push(h));
    req.on('response', (h) => (response = h));
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      session.close();
      resolve({ status: Number(response[':status']), headers: response, body: Buffer.concat(chunks), interim });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
  });
}
const json = (reply: Reply) => JSON.parse(reply.body.toString());
const careful = async (headers: Record<string, string> = {}) => {
  const created = await request('POST', '/$uploads', { 'upload-complete': '?0', ...headers }, new Uint8Array(0));
  assert.equal(created.status, 201);
  return String(created.headers.location);
};
const patch = (location: string, offset: number, complete: boolean, body: Uint8Array, headers: Record<string, string> = {}) =>
  request('PATCH', location, { 'content-type': 'application/partial-upload', 'upload-offset': String(offset), 'upload-complete': complete ? '?1' : '?0', ...headers }, body);

describe('resumable uploads (draft-14)', () => {
  test('OPTIONS announces support and limits (§5.2)', async () => {
    const reply = await request('OPTIONS', '/$uploads');
    assert.equal(reply.status, 204);
    assert.match(String(reply.headers['upload-limit']), /^max-size=4194304, max-age=60$/);
  });

  test('one-shot creation with Upload-Complete: ?1 answers as the target resource (201 + reference)', async () => {
    const data = randomBytes(300_000);
    const reply = await request('POST', '/$uploads', { 'upload-complete': '?1', 'upload-length': String(data.byteLength), 'content-type': 'application/octet-stream' }, data);
    assert.equal(reply.status, 201);
    assert.equal(reply.headers['upload-complete'], '?1');
    const { upload, size } = json(reply);
    assert.equal(size, data.byteLength);
    assert.equal(reply.headers.location, `/$uploads/${upload}`);
    assert.match(upload, /^[A-Za-z0-9_-]{22}$/); // 128 random bits (§20.1: hard to guess)
  });

  test('careful creation, appends, offset retrieval, completion', async () => {
    const data = randomBytes(200_000);
    const location = await careful({ 'upload-length': String(data.byteLength) });
    const first = await patch(location, 0, false, data.subarray(0, 70_000));
    assert.equal(first.status, 204);
    assert.equal(first.headers['upload-offset'], '70000');
    assert.equal(first.headers['upload-complete'], '?0');
    const head = await request('HEAD', location);
    assert.equal(head.status, 204);
    assert.equal(head.headers['upload-offset'], '70000');
    assert.equal(head.headers['upload-length'], '200000');
    assert.equal(head.headers['cache-control'], 'no-store');
    const last = await patch(location, 70_000, true, data.subarray(70_000));
    assert.equal(last.status, 201);
    assert.equal(last.headers['upload-complete'], '?1');
    const call = await request('POST', '/files.store', { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ name: 'a', data: { $upload: json(last).upload } })));
    assert.deepEqual(json(call), { name: 'a', size: data.byteLength, sha256: sha(data) });
  });

  test('offset mismatch → 409 with the correct offset and the problem type (§8.2, §14.1)', async () => {
    const location = await careful();
    await patch(location, 0, false, new Uint8Array(10));
    const reply = await patch(location, 5, false, new Uint8Array(10));
    assert.equal(reply.status, 409);
    assert.equal(reply.headers['upload-offset'], '10');
    assert.equal(reply.headers['upload-complete'], '?0');
    const problem = json(reply);
    assert.equal(problem.type, 'https://iana.org/assignments/http-problem-types#mismatching-upload-offset');
    assert.equal(problem['expected-offset'], 10);
    assert.equal(problem['provided-offset'], 5);
  });

  test('appends need application/partial-upload, Upload-Offset and Upload-Complete', async () => {
    const location = await careful();
    assert.equal((await patch(location, 0, false, new Uint8Array(1), { 'content-type': 'application/octet-stream' })).status, 415);
    assert.equal((await request('PATCH', location, { 'content-type': 'application/partial-upload', 'upload-complete': '?0' }, new Uint8Array(1))).status, 400);
    assert.equal((await patch(location, 0, false, new Uint8Array(1), { 'upload-complete': 'yes' })).status, 400);
  });

  test('a completed upload replays its final response for an empty completing append (§8.2)', async () => {
    const location = await careful();
    const done = await patch(location, 0, true, new Uint8Array(5));
    const again = await patch(location, 5, true, new Uint8Array(0));
    assert.equal(again.status, 201);
    assert.deepEqual(json(again), json(done));
    assert.equal((await patch(location, 5, true, new Uint8Array(3))).status, 409); // more data: not a replay
  });

  test('inconsistent Upload-Length → 400 and the upload is gone (§4.3, §14.2)', async () => {
    const beyond = await careful({ 'upload-length': '10' });
    const reply = await patch(beyond, 0, false, new Uint8Array(12));
    assert.equal(reply.status, 400);
    assert.equal(json(reply).type, 'https://iana.org/assignments/http-problem-types#inconsistent-upload-length');
    assert.equal((await request('HEAD', beyond)).status, 404);
    const short = await careful({ 'upload-length': '10' });
    assert.equal((await patch(short, 0, true, new Uint8Array(4))).status, 400);
    const changed = await careful({ 'upload-length': '10' });
    assert.equal((await patch(changed, 0, false, new Uint8Array(2), { 'upload-length': '11' })).status, 400);
  });

  test('limits: announced size 413 at creation, content beyond max-size 413, full store 503', async () => {
    assert.equal((await request('POST', '/$uploads', { 'upload-complete': '?0', 'upload-length': String(5 * MiB) }, new Uint8Array(0))).status, 413);
    const big = await careful();
    assert.equal((await patch(big, 0, true, new Uint8Array(4 * MiB + 1))).status, 413);
    // Fill the 10 MiB store with incomplete uploads of 4 MiB, then one more append must be refused.
    const held = [await careful(), await careful()];
    for (const location of held) assert.equal((await patch(location, 0, false, new Uint8Array(4 * MiB))).status, 204);
    const full = await patch(await careful(), 0, false, new Uint8Array(3 * MiB));
    assert.equal(full.status, 503);
    assert.equal(json(full).retryable, true);
    for (const location of held) assert.equal((await request('DELETE', location)).status, 204); // cancellation frees the store
    assert.equal((await patch(await careful(), 0, true, new Uint8Array(3 * MiB))).status, 201);
  });

  test('DELETE cancels (§9); unknown ids and other credentials see 404 (§20.1)', async () => {
    const location = await careful({ authorization: 'Bearer alice' });
    assert.equal((await request('HEAD', location, { authorization: 'Bearer mallory' })).status, 404);
    assert.equal((await request('HEAD', location)).status, 404); // no credentials is another scope too
    assert.equal((await request('HEAD', location, { authorization: 'Bearer alice' })).status, 204);
    assert.equal((await request('DELETE', location, { authorization: 'Bearer alice' })).status, 204);
    assert.equal((await request('HEAD', location, { authorization: 'Bearer alice' })).status, 404);
    assert.equal((await request('HEAD', '/$uploads/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
    assert.equal((await request('HEAD', '/$uploads/../files.store')).status, 404);
  });

  test('upload resources expire after max-age', async () => {
    const location = await careful();
    now += 59_000;
    assert.match(String((await request('HEAD', location)).headers['upload-limit']), /max-age=1$/);
    now += 2_000;
    assert.equal((await request('HEAD', location)).status, 404);
  });

  test('104 (Upload Resumption Supported) only for clients with the matching interop version (Appendix B)', async () => {
    const withVersion = await request('POST', '/$uploads', { 'upload-complete': '?1', 'upload-draft-interop-version': '10' }, new Uint8Array(100));
    const interim = withVersion.interim.find((h) => Number(h[':status']) === 104);
    assert.ok(interim, 'no 104');
    assert.equal(interim['upload-draft-interop-version'], '10');
    assert.equal(interim.location, withVersion.headers.location);
    assert.match(String(interim['upload-limit']), /max-size=/);
    const without = await request('POST', '/$uploads', { 'upload-complete': '?1' }, new Uint8Array(100));
    assert.equal(without.interim.length, 0);
    const otherVersion = await request('POST', '/$uploads', { 'upload-complete': '?1', 'upload-draft-interop-version': '9' }, new Uint8Array(100));
    assert.equal(otherVersion.interim.length, 0);
  });

  test('an interrupted append keeps what arrived; resuming from Upload-Offset completes it', async () => {
    const data = randomBytes(1 * MiB);
    const location = await careful();
    const session = http2.connect(server.url, { ca: testCert().cert });
    session.on('error', () => {});
    const req = session.request({ ':method': 'PATCH', ':path': location, 'content-type': 'application/partial-upload', 'upload-offset': '0', 'upload-complete': '?1' });
    req.on('error', () => {});
    req.write(data.subarray(0, 300_000));
    for (let i = 0; i < 50 && Number((await request('HEAD', location)).headers['upload-offset']) < 300_000; i++) await sleep(10);
    session.destroy(); // connection lost mid-content
    await sleep(50);
    const offset = Number((await request('HEAD', location)).headers['upload-offset']);
    assert.equal(offset, 300_000);
    const done = await patch(location, offset, true, data.subarray(offset));
    assert.equal(done.status, 201);
    const call = await request('POST', '/files.store', { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ name: 'r', data: { $upload: json(done).upload } })));
    assert.equal(json(call).sha256, sha(data));
  });

  test('a newer append supersedes one still in flight (its connection may be dead)', async () => {
    const location = await careful();
    const session = http2.connect(server.url, { ca: testCert().cert });
    session.on('error', () => {});
    const stale = session.request({ ':method': 'PATCH', ':path': location, 'content-type': 'application/partial-upload', 'upload-offset': '0', 'upload-complete': '?1' });
    stale.on('error', () => {});
    const staleStatus = new Promise<number>((resolve) => stale.on('response', (h) => resolve(Number(h[':status']))));
    stale.write(new Uint8Array(1000)); // never ended: looks like a hung connection
    for (let i = 0; i < 50 && Number((await request('HEAD', location)).headers['upload-offset']) < 1000; i++) await sleep(10);
    const done = await patch(location, 1000, true, new Uint8Array(500));
    assert.equal(done.status, 201);
    assert.equal(json(done).size, 1500);
    assert.equal(await staleStatus, 409);
    session.destroy();
  });
});

describe('upload references in op inputs', () => {
  const upload = async (bytes: Uint8Array, headers: Record<string, string> = {}) => json(await request('POST', '/$uploads', { 'upload-complete': '?1', ...headers }, bytes)).upload as string;
  const store = (input: unknown, headers: Record<string, string> = {}) => request('POST', '/files.store', { 'content-type': 'application/json', ...headers }, Buffer.from(JSON.stringify(input)));

  test('unknown, incomplete or foreign references → 400 with the field path', async () => {
    for (const ref of ['AAAAAAAAAAAAAAAAAAAAAA', (await careful()).split('/').pop()!, await upload(new Uint8Array(3), { authorization: 'Bearer other' })]) {
      const reply = await store({ name: 'x', data: { $upload: ref } });
      assert.equal(reply.status, 400);
      assert.deepEqual(json(reply).fields, [{ path: 'data', message: 'unknown, incomplete or expired upload' }]);
    }
    const id = await upload(new Uint8Array(3));
    assert.equal((await store({ name: 'x', data: 'not a reference' })).status, 400);
    assert.equal((await store({ name: 'x', data: { $upload: id, extra: 1 } })).status, 400);
    assert.equal((await store({ name: 'x', data: { $upload: id }, thumb: { $upload: id } })).status, 200); // optional field, same upload twice
  });

  test('idempotent retries replay without re-executing; the key identity is the reference', async () => {
    const id = await upload(randomBytes(64_000));
    const before = executions;
    const first = await store({ name: 'k', data: { $upload: id } }, { 'idempotency-key': '"store-1"' });
    const again = await store({ name: 'k', data: { $upload: id } }, { 'idempotency-key': '"store-1"' });
    assert.equal(executions, before + 1);
    assert.equal(again.headers['apue-replayed'], '?1');
    assert.deepEqual(json(again), json(first));
    const other = await store({ name: 'k', data: { $upload: await upload(randomBytes(10)) } }, { 'idempotency-key': '"store-1"' });
    assert.equal(other.status, 422); // same key, different payload
  });

  test('ops with bytes in a unary input need uploads enabled', () => {
    const { key, cert } = testCert();
    assert.throws(() => createApueServer(api, handlers, { key, cert }), /files\.store has bytes in a unary input/);
  });
});
