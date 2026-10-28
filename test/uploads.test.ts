// Resumable uploads (draft-ietf-httpbis-resumable-upload-14, research/06) and upload references in
// op inputs. Wire-level: raw node:http2 requests, so every header is under the test's control.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import tls from 'node:tls';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, fetchTransport, type Transport, type TransportRequest } from '../src/client.ts';
import { ApueError } from '../src/protocol.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { UploadStore } from '../src/uploads.ts';
import { FrameDecoder, FrameType } from '../src/frame.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const MiB = 1024 * 1024;
const api = defineApi({
  'files.store': op({
    effect: 'unsafe',
    input: t.object({ name: t.string(), data: t.bytes(), thumb: t.optional(t.bytes()) }),
    output: t.object({ name: t.string(), size: t.number(), sha256: t.string() }),
  }),
  'files.flaky': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.number() }),
  'files.scramble': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.string() }),
  'meta.put': op({ effect: 'unsafe', input: t.object({ meta: t.unknown(), n: t.number() }), output: t.number() }),
});
let flakyCalls = 0;
let executions = 0;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const handlers: Handlers<typeof api> = {
  'files.store': ({ name, data }) => {
    executions++;
    return { name, size: data.byteLength, sha256: sha(data) };
  },
  'files.scramble': ({ data }) => {
    const before = sha(data);
    data.fill(0); // a handler changing its input in place
    return before;
  },
  'meta.put': ({ n }) => n,
  'files.flaky': ({ data }) => {
    if (++flakyCalls === 1) throw new ApueError(503, 'Service Unavailable', 'try again', { retryable: true }, { 'retry-after': '0' });
    return data.byteLength;
  },
};

let now = 1_000_000;
let server: { url: string; close(): Promise<void> };
before(async () => {
  // scopeBytes above storeBytes: these tests use one scope and need the store-wide limit reachable
  server = await startServer(api, handlers, { uploads: { maxBytes: 4 * MiB, storeBytes: 10 * MiB, scopeBytes: 20 * MiB, ttlMs: 60_000, now: () => now } });
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

  /** A server with small quotas; `at` sends one raw request to it. */
  async function quotaServer(uploads: Record<string, unknown>) {
    const small = await startServer(api, handlers, { uploads: { maxBytes: 4 * MiB, storeBytes: 10 * MiB, scopeBytes: 1 * MiB, scopeUploads: 3, ...uploads } });
    const at = (method: string, path: string, headers: Record<string, string>, body?: Uint8Array) =>
      new Promise<Reply>((resolve, reject) => {
        const session = http2.connect(small.url, { ca: testCert().cert });
        session.on('error', reject);
        const req = session.request({ ':method': method, ':path': path, ...headers }, { endStream: body === undefined });
        const chunks: Buffer[] = [];
        let response: http2.IncomingHttpHeaders = {};
        req.on('response', (h) => (response = h));
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => (session.close(), resolve({ status: Number(response[':status']), headers: response, body: Buffer.concat(chunks), interim: [] })));
        req.on('error', reject);
        if (body !== undefined) req.end(body);
      });
    return { small, at };
  }

  test('quotas per client address: a made-up Authorization does not buy a fresh quota', async () => {
    const { small, at } = await quotaServer({});
    try {
      assert.equal((await at('OPTIONS', '/$uploads', {})).headers['upload-limit'], `max-size=${MiB}, max-age=3600`); // min(maxBytes, scopeBytes)
      assert.equal((await at('POST', '/$uploads', { authorization: 'x1', 'upload-complete': '?1' }, new Uint8Array(MiB))).status, 201);
      // review finding: a new Authorization value used to open a new bucket (four filled the store)
      assert.equal((await at('POST', '/$uploads', { authorization: 'x2', 'upload-complete': '?1' }, new Uint8Array(1))).status, 507);
      assert.equal((await at('POST', '/$uploads', { 'upload-complete': '?1' }, new Uint8Array(1))).status, 507);
      const served = await (await fetch(`${small.url}/.well-known/apue`)).json();
      assert.deepEqual(served.limits.uploads, { path: '/$uploads', maxBytes: MiB, clientBytes: MiB, clientUploads: 3, maxAgeSeconds: 3600 }); // the effective limit
    } finally {
      await small.close();
    }
  });

  test('clientKey: an application that authenticates gives each user a quota (bytes and uploads)', async () => {
    const { small, at } = await quotaServer({ clientKey: ({ headers }: { headers: http2.IncomingHttpHeaders }) => String(headers.authorization) });
    try {
      const alice = { authorization: 'Bearer alice', 'upload-complete': '?1' };
      assert.equal((await at('POST', '/$uploads', { ...alice, 'upload-length': String(MiB + 1) }, new Uint8Array(0))).status, 413); // can never fit
      assert.equal((await at('POST', '/$uploads', alice, new Uint8Array(MiB))).status, 201);
      assert.equal((await at('POST', '/$uploads', alice, new Uint8Array(1))).status, 507); // alice's 1 MiB are used up …
      assert.equal((await at('POST', '/$uploads', { authorization: 'Bearer bob', 'upload-complete': '?1' }, new Uint8Array(MiB))).status, 201); // … bob is unaffected
      const many = { authorization: 'Bearer carol', 'upload-complete': '?0' };
      for (let i = 0; i < 3; i++) assert.equal((await at('POST', '/$uploads', many, new Uint8Array(0))).status, 201);
      assert.equal((await at('POST', '/$uploads', many, new Uint8Array(0))).status, 507); // 3 uploads per client
    } finally {
      await small.close();
    }
  });

  test('announced lengths are reserved: parallel creations cannot overbook; a later Upload-Length too', async () => {
    const { small, at } = await quotaServer({});
    try {
      const announce = (n: number) => at('POST', '/$uploads', { 'upload-complete': '?0', 'upload-length': String(n) }, new Uint8Array(0));
      assert.equal((await announce(600 * 1024)).status, 201);
      assert.equal((await announce(600 * 1024)).status, 507); // used to pass and fail midway
      const later = await at('POST', '/$uploads', { 'upload-complete': '?0' }, new Uint8Array(0));
      const location = String(later.headers.location);
      const appended = await at('PATCH', location, { 'content-type': 'application/partial-upload', 'upload-offset': '0', 'upload-complete': '?0', 'upload-length': String(600 * 1024) }, new Uint8Array(1));
      assert.equal(appended.status, 507);
    } finally {
      await small.close();
    }
  });

  test('unannounced content beyond what one client may hold is 413 (too large), not 507 (quota)', async () => {
    const { small, at } = await quotaServer({});
    try {
      assert.equal((await at('POST', '/$uploads', { 'upload-complete': '?1' }, new Uint8Array(MiB + 1))).status, 413);
    } finally {
      await small.close();
    }
  });

  test('uploads are refused over WebSocket (plain HTTP only)', async () => {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), testCert().cert]);
    const ws = new WebSocket(`${server.url.replace('https', 'wss')}/$uploads`, 'apue.v1');
    ws.binaryType = 'arraybuffer';
    const chunks: Uint8Array[] = [];
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) chunks.push(new Uint8Array(event.data));
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(new Uint8Array(0));
    await new Promise((resolve) => (ws.onclose = resolve));
    const frames = [...new FrameDecoder().push(Buffer.concat(chunks))];
    const end = frames.find((f) => f.type === FrameType.END);
    assert.ok(end, 'no END frame');
    assert.equal((JSON.parse(Buffer.from(end.payload).toString()) as { status: number }).status, 400);
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

test('UploadStore: appending to a deleted upload is refused and leaves the accounting alone', () => {
  const store = new UploadStore({ scopeBytes: 100, scopeUploads: 1 });
  const upload = store.create('s', 'q', undefined);
  store.append(upload, new Uint8Array(10));
  store.delete(upload);
  assert.equal(store.storedBytes, 0);
  assert.throws(() => store.append(upload, new Uint8Array(10)), (e: ApueError) => e.status === 404);
  assert.equal(store.storedBytes, 0);
  const next = store.create('s', 'q', undefined); // the quota was freed completely (1 upload, 100 bytes)
  store.append(next, new Uint8Array(100));
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

  test('the idempotency identity is the content: a re-upload (new id) with the same key replays', async () => {
    const bytes = randomBytes(10_000);
    const before = executions;
    const first = await store({ name: 'c', data: { $upload: await upload(bytes) } }, { 'idempotency-key': '"content-1"' });
    const again = await store({ name: 'c', data: { $upload: await upload(bytes) } }, { 'idempotency-key': '"content-1"' });
    assert.equal(again.status, 200);
    assert.equal(again.headers['apue-replayed'], '?1');
    assert.deepEqual(json(again), json(first));
    assert.equal(executions, before + 1);
  });

  test('a handler changing its bytes in place cannot corrupt the upload for later uses', async () => {
    const bytes = randomBytes(5000);
    const id = await upload(bytes);
    const call = () => request('POST', '/files.scramble', { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ data: { $upload: id } })));
    assert.equal(json(await call()), sha(bytes));
    assert.equal(json(await call()), sha(bytes));
  });

  test('ops with bytes in a unary input need uploads enabled', () => {
    const { key, cert } = testCert();
    assert.throws(() => createApueServer(api, handlers, { key, cert }), /files\.store has bytes in a unary input/);
  });
});

describe('client uploads (ApueClient.upload and t.bytes() inputs)', () => {
  /** Records requests; `tamper` may replace a request (e.g. cut its body) before it is sent. */
  function recording(inner: Transport, tamper?: (req: TransportRequest, index: number) => TransportRequest | Promise<never>) {
    const log: TransportRequest[] = [];
    const transport: Transport = {
      request(req) {
        log.push(req);
        const changed = tamper?.(req, log.length - 1);
        if (changed instanceof Promise) return changed;
        return inner.request(changed ?? req);
      },
      close: () => inner.close?.() ?? Promise.resolve(),
    };
    return { transport, log };
  }
  const h2 = () => http2Transport(server.url, { ca: testCert().cert });

  test('t.bytes() inputs upload automatically (node:http2 and fetch); the handler gets the bytes', async () => {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), testCert().cert]);
    const data = new Uint8Array(randomBytes(2 * MiB));
    for (const transport of [h2(), fetchTransport(server.url)]) {
      const { transport: t1, log } = recording(transport);
      const client = new ApueClient(api, t1);
      assert.deepEqual(await client.call('files.store', { name: 'f', data }), { name: 'f', size: data.byteLength, sha256: sha(data) });
      await client.close(); // waits for the cleanup of the call's upload
      assert.deepEqual(log.map((r) => `${r.method} ${r.path.split('/').slice(0, 2).join('/')}`), ['POST /$uploads', 'PATCH /$uploads', 'POST /files.store', 'DELETE /$uploads']);
    }
  });

  test('a connection lost mid-upload resumes from the server\'s offset: only the rest is sent again', async () => {
    const data = new Uint8Array(randomBytes(1 * MiB));
    const { transport, log } = recording(h2(), (req, index) => {
      if (req.method !== 'PATCH' || index !== 1) return req;
      const body = req.body as Uint8Array;
      return {
        ...req,
        body: (async function* () {
          yield body.subarray(0, 400_000);
          await sleep(50);
          throw new Error('ECONNRESET (simulated)');
        })(),
      };
    });
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    const ref = await client.upload(data);
    const patches = log.filter((r) => r.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.equal(patches[1]!.headers['upload-offset'], '400000');
    assert.equal((patches[1]!.body as Uint8Array).byteLength, data.byteLength - 400_000);
    assert.equal(log.filter((r) => r.method === 'HEAD').length, 1);
    assert.equal((await client.call('files.store', { name: 'x', data: ref })).sha256, sha(data)); // a reference passes as is (typed)
    await client.close();
  });

  test('an offset conflict (409) is recovered via offset retrieval', async () => {
    const { transport, log } = recording(h2(), (req, index) => (req.method === 'PATCH' && index === 1 ? { ...req, headers: { ...req.headers, 'upload-offset': '7' } } : req));
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    const data = new Uint8Array(randomBytes(1000));
    const ref = await client.upload(data);
    assert.ok(ref.$upload);
    assert.deepEqual(log.map((r) => r.method), ['POST', 'PATCH', 'HEAD', 'PATCH']);
    await client.close();
  });

  test('never PATCHes a location outside /$uploads', async () => {
    const fake: Transport = {
      async request(req) {
        assert.equal(req.method, 'POST', 'must not follow the location');
        return { status: 201, headers: new Headers({ location: 'https://evil.example/collect' }), body: (async function* () {})() };
      },
    };
    await assert.rejects(new ApueClient(api, fake).upload(new Uint8Array(1)), (e: ApueError) => e.status === 502 && /unexpected upload location/.test(e.message));
  });

  test('gives up after its resume budget; honours the caller\'s abort', async () => {
    const failing = recording(h2(), (req) => (req.method === 'PATCH' ? Promise.reject(new Error('ECONNRESET (simulated)')) : req));
    const client = new ApueClient(api, failing.transport, { backoffMs: 1 });
    await assert.rejects(client.upload(new Uint8Array(10), { resumes: 2 }), /ECONNRESET/);
    assert.equal(failing.log.filter((r) => r.method === 'PATCH').length, 3);
    const controller = new AbortController();
    const slow = recording(h2(), (req) =>
      req.method === 'PATCH'
        ? new Promise<never>((_resolve, reject) => {
            req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }); // as real transports do
            controller.abort(new Error('stop'));
          })
        : req,
    );
    await assert.rejects(new ApueClient(api, slow.transport).upload(new Uint8Array(10), { signal: controller.signal }), /stop/);
    await client.close();
  });

  test('creation and offset retrieval are retried after a lost connection', async () => {
    let failedPost = false;
    let failedHead = false;
    const { transport, log } = recording(h2(), (req, index) => {
      if (req.method === 'POST' && req.path === '/$uploads' && !failedPost) return (failedPost = true), Promise.reject(new Error('ECONNRESET (simulated)'));
      if (req.method === 'HEAD' && !failedHead) return (failedHead = true), Promise.reject(new Error('ECONNRESET (simulated)'));
      if (req.method === 'PATCH' && index === 2) return Promise.reject(new Error('ECONNRESET (simulated)')); // first PATCH lost → offset retrieval
      return req;
    });
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    assert.ok((await client.upload(new Uint8Array(3000))).$upload);
    assert.deepEqual(log.map((r) => r.method), ['POST', 'POST', 'PATCH', 'HEAD', 'HEAD', 'PATCH']);
    await client.close();
  });

  test('the same buffer at two positions is uploaded once; fields upload concurrently', async () => {
    const { transport, log } = recording(h2());
    const client = new ApueClient(api, transport);
    const shared = new Uint8Array(randomBytes(2000));
    const result = await client.call('files.store', { name: 's', data: shared, thumb: shared });
    assert.equal(result.sha256, sha(shared));
    await client.close();
    assert.equal(log.filter((r) => r.method === 'POST' && r.path === '/$uploads').length, 1);
  });

  test('batches upload bytes too, and accept references', async () => {
    const { transport, log } = recording(h2());
    const client = new ApueClient(api, transport);
    const a = new Uint8Array(randomBytes(3000));
    const b = new Uint8Array(randomBytes(4000));
    const ref = await client.upload(b);
    const batch = client.batch();
    const first = batch.call('files.store', { name: 'a', data: a });
    const second = batch.call('files.store', { name: 'b', data: ref });
    await batch.send();
    assert.equal((await first.result).sha256, sha(a));
    assert.equal((await second.result).sha256, sha(b));
    await client.close();
    // the batch's own upload is cleaned up; the caller's upload() reference is theirs to keep
    assert.equal(log.filter((r) => r.method === 'DELETE').length, 1);
  });

  test('when one upload of a call fails, the completed ones are deleted (call and batch)', async () => {
    const inner = h2();
    const tooBig = new Uint8Array(5 * MiB); // > max-size: 413 at creation
    // The small uploads finish only after the big one has failed: cleanup must wait for them.
    const { transport, log } = recording(inner, (req) => (req.method === 'PATCH' ? (sleep(150).then(() => inner.request(req)) as never) : req));
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    await assert.rejects(client.call('files.store', { name: 'x', data: tooBig, thumb: new Uint8Array(100) }), (e: ApueError) => e.status === 413);
    const batch = client.batch();
    batch.call('files.store', { name: 'a', data: new Uint8Array(100) });
    batch.call('files.store', { name: 'b', data: tooBig });
    await assert.rejects(batch.send(), (e: ApueError) => e.status === 413);
    await client.close();
    const completed = log.filter((r) => r.method === 'PATCH').map((r) => r.path);
    assert.equal(completed.length, 2); // the two small uploads
    assert.deepEqual(log.filter((r) => r.method === 'DELETE').map((r) => r.path).sort(), completed.sort());
  });

  test('a completed upload naming another id than its location is refused (and cleaned up)', async () => {
    const seen: string[] = [];
    const fake: Transport = {
      async request(req) {
        seen.push(`${req.method} ${req.path}`);
        const body = req.method === 'PATCH' ? JSON.stringify({ upload: '../files.store' }) : '';
        const headers = new Headers(req.method === 'POST' ? { location: '/$uploads/abcdefghijklmnopqrstuv' } : { 'upload-complete': '?1' });
        return { status: req.method === 'DELETE' ? 204 : 201, headers, body: (async function* () { yield new TextEncoder().encode(body); })() };
      },
    };
    const client = new ApueClient(api, fake);
    await assert.rejects(client.upload(new Uint8Array(3)), (e: ApueError) => e.status === 502 && /another id/.test(e.message));
    await client.close();
    assert.deepEqual(seen, ['POST /$uploads', 'PATCH /$uploads/abcdefghijklmnopqrstuv', 'DELETE /$uploads/abcdefghijklmnopqrstuv']);
  });

  test('Retry-After is honoured; 507 (quota) is not retried', async () => {
    let busy = true;
    const { transport } = recording(h2(), (req) => {
      if (req.method === 'PATCH' && busy) {
        busy = false;
        return Promise.resolve({ status: 503, headers: new Headers({ 'retry-after': '1', 'content-type': 'application/problem+json' }), body: (async function* () {})() }) as never;
      }
      return req;
    });
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    const started = performance.now();
    await client.upload(new Uint8Array(10));
    assert.ok(performance.now() - started >= 900, 'retried before Retry-After');
    await client.close();
    const quota = await startServer(api, handlers, { uploads: { scopeBytes: 64 * 1024, scopeUploads: 1 } });
    try {
      const { transport: t2, log } = recording(http2Transport(quota.url, { ca: testCert().cert }));
      const limited = new ApueClient(api, t2, { backoffMs: 1 });
      await limited.upload(new Uint8Array(10));
      await assert.rejects(limited.upload(new Uint8Array(10)), (e: ApueError) => e.status === 507);
      assert.equal(log.filter((r) => r.method === 'POST').length, 2); // once each: no retries of the 507
      await limited.close();
    } finally {
      await quota.close();
    }
  });

  test('close() does not hang on an unanswered DELETE (time-boxed)', { timeout: 15_000 }, async () => {
    const { transport } = recording(h2(), (req) =>
      req.method === 'DELETE' ? (new Promise<never>((_resolve, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })) as never) : req,
    );
    const client = new ApueClient(api, transport);
    await client.call('files.store', { name: 'd', data: new Uint8Array(10) });
    const started = performance.now();
    await client.close();
    assert.ok(performance.now() - started < 7000, `close took ${(performance.now() - started).toFixed(0)} ms`);
  });

  test('batch inputs with bytes are validated in add(), naming the call', async () => {
    const client = new ApueClient(api, h2());
    const batch = client.batch();
    batch.call('files.store', { name: 'ok', data: new Uint8Array(1) });
    assert.throws(() => batch.call('files.store', { name: 1 as unknown as string, data: new Uint8Array(1) }), /input of call 1/);
    const ref = await client.upload(new Uint8Array(4));
    const picked = await client.pick('files.store', { name: 'p', data: ref }, ['size']); // UploadRef is typed for pick() too
    assert.deepEqual(picked, { size: 4 });
    await client.close();
  });

  test('batch: an op without bytes is validated in add() even if its input looks like an upload reference', () => {
    const batch = new ApueClient(api, h2()).batch();
    assert.throws(() => batch.call('meta.put', { meta: { $upload: 'x' }, n: 'oops' as unknown as number }), /input of call 0/);
  });

  test('batch: one buffer in two calls is uploaded once', async () => {
    const { transport, log } = recording(h2());
    const client = new ApueClient(api, transport);
    const shared = new Uint8Array(randomBytes(3000));
    const batch = client.batch();
    const a = batch.call('files.store', { name: 'a', data: shared });
    const b = batch.call('files.store', { name: 'b', data: shared });
    await batch.send();
    assert.equal((await a.result).sha256, (await b.result).sha256);
    await client.close();
    assert.equal(log.filter((r) => r.method === 'POST' && r.path === '/$uploads').length, 1);
  });

  test('invalid input fails on the client before anything is uploaded', async () => {
    const { transport, log } = recording(h2());
    const client = new ApueClient(api, transport);
    await assert.rejects(client.call('files.store', { name: 1 as unknown as string, data: new Uint8Array(3) }), (e: ApueError) => e.status === 400);
    await assert.rejects(client.call('files.store', { name: 'n', data: 'nope' as unknown as Uint8Array }), (e: ApueError) => e.status === 400);
    assert.equal(log.length, 0);
    await client.close();
  });

  test('a retried op call reuses its upload (no second upload)', async () => {
    const { transport, log } = recording(h2());
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    assert.equal(await client.call('files.flaky', { data: new Uint8Array(5000) }), 5000);
    await client.close();
    assert.deepEqual(log.map((r) => `${r.method} ${r.path.split('/')[1]}`), ['POST $uploads', 'PATCH $uploads', 'POST files.flaky', 'POST files.flaky', 'DELETE $uploads']);
  });
});
