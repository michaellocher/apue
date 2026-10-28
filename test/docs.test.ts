// Documentation derived from the op definitions (src/docs.ts, research/08): HTTP shape, protocol
// errors, placeholder examples, limits — and a drift guard: every error the server answers a
// malformed request with must be one the manifest documents for that op.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { opErrors, PROTOCOL_ERRORS, type ProblemRef } from '../src/docs.ts';
import { encodeFrame, endFrame, msgFrame } from '../src/frame.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { buildManifest, type Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string({ min: 3 }) }), output: t.object({ id: t.string(), role: t.enum(['admin', 'member']), age: t.optional(t.number({ int: true, min: 18 })) }) }),
  'users.code': op({ effect: 'safe', input: t.void(), output: t.object({ code: t.string({ pattern: /^[A-Z]{3}-\d+$/ }) }) }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'events.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ from: t.number() }), output: t.number() }),
  'numbers.sum': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'files.get': op({ effect: 'safe', input: t.void(), output: t.object({ data: t.bytes() }) }),
  'files.put': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.void() }),
});
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id, role: 'member' }),
  'users.code': () => ({ code: 'ABC-1' }),
  'orders.create': async () => {
    await sleep(300); // long enough for a concurrent request with the same key
    return 1;
  },
  'events.watch': async function* ({ from }, ctx) {
    yield from;
    ctx.checkpoint(String(from));
    await sleep(2_000);
  },
  'numbers.sum': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'files.get': () => ({ data: new Uint8Array([1, 2, 3]) }),
  'files.put': () => undefined,
};

describe('derived documentation in the manifest', () => {
  const manifest = buildManifest(api) as { http: object; errors: ProblemRef[]; ops: Record<string, any> };

  test('HTTP shape per op kind, as the server routes it', () => {
    assert.deepEqual(manifest.ops['users.get'].http, { methods: ['GET', 'HEAD', 'QUERY', 'POST'], path: '/users.get', request: MediaType.JSON, response: [MediaType.JSON] });
    assert.deepEqual(manifest.ops['orders.create'].http, { methods: ['POST'], path: '/orders.create', request: MediaType.JSON, response: [MediaType.JSON], idempotencyKey: true });
    assert.deepEqual(manifest.ops['events.watch'].http.response, [MediaType.STREAM_JSON, MediaType.SSE]);
    assert.equal(manifest.ops['numbers.sum'].http.request, MediaType.STREAM_JSON);
    assert.equal(manifest.ops['numbers.sum'].http.idempotencyKey, undefined); // request streams are never keyed
    assert.deepEqual(manifest.ops['files.get'].http.response, [MediaType.STREAM_JSON]); // unary bytes output: framed
    assert.ok(manifest.errors.some((e) => e.status === 504));
    assert.ok('getInput' in manifest.http);
  });

  test('protocol errors per op kind', () => {
    const statuses = (name: string) => manifest.ops[name].errors.map((e: ProblemRef) => `${e.status} ${e.title}`);
    assert.deepEqual(statuses('users.get'), ['408 Request Timeout']);
    assert.deepEqual(statuses('orders.create'), ['408 Request Timeout', '409 Idempotency Key In Progress', '422 Idempotency Key Reused']);
    assert.deepEqual(statuses('events.watch'), ['408 Request Timeout', '400 Invalid Resume Token']);
    assert.deepEqual(statuses('numbers.sum'), ['400 Malformed Stream', '400 Truncated Stream']);
  });

  test('placeholder examples: valid against the schema, left out when they cannot be, never for void', () => {
    assert.deepEqual(manifest.ops['users.get'].example, { input: { id: 'string' }, output: { id: 'string', role: 'admin', age: 18 } });
    assert.equal(manifest.ops['users.code'].example, undefined); // a pattern the placeholder can't meet; void input
    assert.deepEqual(manifest.ops['files.put'].example, { input: { data: { $upload: '<upload id>' } } }); // bytes in: the reference form
    assert.equal(manifest.ops['files.get'].example, undefined); // bytes out travel as BLOB frames
    assert.deepEqual(manifest.ops['events.watch'].example, { input: { from: 0 }, output: 0 }); // single messages
    for (const [name, def] of Object.entries(api)) {
      const example = manifest.ops[name].example;
      if (example?.output !== undefined) assert.doesNotThrow(() => def.output.parse(example.output), name);
    }
  });
});

describe('drift guard: the server only answers with documented errors', () => {
  let server: { url: string; close(): Promise<void> };
  let served: { limits: Record<string, any>; ops: Record<string, any> };
  before(async () => {
    server = await startServer(api, handlers, { maxBodyBytes: 1024, bodyTimeoutMs: 200, resume: { secret: 'a shared replica secret, 32 bytes!!' }, uploads: { maxBytes: 4096 } });
    served = await (await fetch(`${server.url}/.well-known/apue`)).json();
  });
  after(() => server.close());

  function request(path: string, headers: Record<string, string>, body?: Uint8Array | string, keepOpen = false): Promise<{ status: number; type: string }> {
    return new Promise((resolve, reject) => {
      const session = http2.connect(server.url, { ca: testCert().cert });
      session.on('error', reject);
      const req = session.request({ ':path': path, ...headers }, { endStream: body === undefined && !keepOpen });
      const chunks: Buffer[] = [];
      let status = 0;
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (keepOpen) session.destroy(); // our side never finished: close() would wait for it forever
        else session.close();
        const text = Buffer.concat(chunks).toString();
        let type = 'about:blank';
        try {
          type = (JSON.parse(text) as { type?: string }).type ?? 'about:blank';
        } catch {
          // not a problem document
        }
        resolve({ status, type });
      });
      req.on('error', reject);
      if (body !== undefined) {
        if (keepOpen) req.write(body);
        else req.end(body);
      }
    });
  }
  const documented = (name: string) => [...PROTOCOL_ERRORS, ...served.ops[name].errors].map((e: ProblemRef) => `${e.status} ${e.type}`);
  const seen: string[] = [];
  async function expectDocumented(name: string, answer: Promise<{ status: number; type: string }>, expected: number) {
    const { status, type } = await Promise.race([answer, sleep(3000).then(() => assert.fail(`${name}: no answer for the ${expected} case`))]);
    assert.equal(status, expected, `${name}: expected ${expected}, got ${status} ${type}`);
    assert.ok(documented(name).includes(`${status} ${type}`), `${name} answered ${status} ${type}, which its manifest entry does not document`);
    seen.push(`${status} ${type}`);
  }
  const json = { ':method': 'POST', 'content-type': MediaType.JSON };

  test('limits come from the server options', () => {
    assert.equal(served.limits.maxBodyBytes, 1024);
    assert.equal(served.limits.bodyTimeoutMs, 200);
    assert.equal(served.limits.uploads.maxBytes, 4096);
    assert.equal(served.limits.maxSelectPaths, 64);
  });

  test('malformed requests of every kind', async () => {
    await expectDocumented('users.get', request('/users.get', { ':method': 'DELETE' }), 405);
    await expectDocumented('users.get', request('/users.get', { ':method': 'POST', 'content-type': 'text/plain' }, 'x'), 415);
    await expectDocumented('users.get', request('/users.get', json, '{nope'), 400);
    await expectDocumented('users.get', request('/users.get', json, '{"id":"x"}'), 400); // validation
    await expectDocumented('users.get', request('/users.get?i=%7Bbroken', { ':method': 'GET' }), 400);
    await expectDocumented('users.get', request('/users.get?s=nope', json, '{"id":"abc"}'), 400); // selection
    await expectDocumented('users.get', request('/users.get', { ...json, 'apue-timeout': 'soon' }, '{"id":"abc"}'), 400);
    await expectDocumented('users.get', request('/users.get', json, `{"id":"${'x'.repeat(2000)}"}`), 413);
    await expectDocumented('users.get', request('/users.get', json, '{"id":', true), 408); // body never completes
    await expectDocumented('orders.create', request('/orders.create', { ...json, 'apue-timeout': '50' }, '{"item":"a"}'), 504);
    await expectDocumented('orders.create', request('/orders.create', { ...json, 'idempotency-key': '""' }, '{"item":"a"}'), 400);
    const first = request('/orders.create', { ...json, 'idempotency-key': '"k-drift"' }, '{"item":"a"}');
    await sleep(50);
    await expectDocumented('orders.create', request('/orders.create', { ...json, 'idempotency-key': '"k-drift"' }, '{"item":"a"}'), 409);
    await first;
    await expectDocumented('orders.create', request('/orders.create', { ...json, 'idempotency-key': '"k-drift"' }, '{"item":"b"}'), 422);
    await expectDocumented('events.watch', request('/events.watch?i=%7B%22from%22%3A1%7D', { ':method': 'GET', accept: MediaType.STREAM_JSON, 'apue-resume': 'forged' }), 400);
    const frames = { ':method': 'POST', 'content-type': MediaType.STREAM_JSON };
    await expectDocumented('numbers.sum', request('/numbers.sum', frames, Buffer.from(encodeFrame(0x02, new Uint8Array([1]), 7))), 400); // malformed
    await expectDocumented('numbers.sum', request('/numbers.sum', frames, Buffer.from(msgFrame(1))), 400); // truncated: no END
    await expectDocumented('files.put', request('/files.put', json, '{"data":{"$upload":"AAAAAAAAAAAAAAAAAAAAAA"}}'), 400);
    await expectDocumented('nope.nothing' in served.ops ? 'nope.nothing' : 'users.get', request('/nope.nothing', json, '{}'), 404);
    void endFrame;
    // Each documented kind was actually provoked at least once.
    for (const kind of ['400 about:blank', '405 about:blank', '408 about:blank', '409 https://apue.dev/problems/idempotency-key-in-progress', '413 about:blank', '415 about:blank', '422 https://apue.dev/problems/idempotency-key-reused', '504 https://apue.dev/problems/deadline-exceeded']) {
      assert.ok(seen.includes(kind), `never provoked: ${kind}`);
    }
    assert.ok(opErrors(api['numbers.sum']).length === 2);
  });
});
