// Python clients generated from the manifest (`apue-types --lang python`): a real Python 3 process
// calls a real server — unary, streams, errors, idempotency, deadlines, bytes, uploads, downloads,
// resumed streams through a proxy that cuts connections, batches, compression, client-side validation
// (checked against the TypeScript schemas, JavaScript RegExp semantics included).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { defineApi, op } from '../src/api.ts';
import { generatePython, pythonName } from '../src/codegen-python.ts';
import { download } from '../src/downloads.ts';
import { ApueError } from '../src/protocol.ts';
import { t, type Schema } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

// APUE_PYTHON=python3.12 npm test — to try another interpreter.
const python = (() => {
  const command = process.env.APUE_PYTHON ?? 'python3';
  try {
    const version = execFileSync(command, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' }).trim();
    return version === 'True' ? command : undefined;
  } catch {
    return undefined;
  }
})();

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string({ min: 2 }) }), output: t.object({ id: t.string(), role: t.enum(['admin', 'member']), tags: t.optional(t.array(t.string())) }) }),
  'users.none': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'orders.fail': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number() }), output: t.number() }),
  'count.fail': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'echo.bidi': op({ effect: 'unsafe', stream: 'bidi', input: t.object({ n: t.number() }), output: t.object({ n: t.number() }) }),
  'files.echo': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.object({ data: t.bytes(), size: t.number() }) }),
  'files.ingest': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.object({ size: t.number(), sha256: t.string() }) }),
  'export.get': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download() }) }),
  'slow.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'class': op({ effect: 'safe', input: t.void(), output: t.object({ 'odd-key': t.nullable(t.number()) }) }),
});
const EXPORT = new Uint8Array(2 * 1024 * 1024 + 3).map((_, i) => i % 253);
let orders = 0;
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id, role: 'member', tags: ['a'] }),
  'users.none': () => 'none',
  'orders.create': () => ++orders,
  'orders.fail': () => {
    throw new ApueError(409, 'Out Of Stock', 'item gone', { type: 'https://example.com/problems/out-of-stock' });
  },
  'count.up': async function* ({ to }) {
    for (let i = 1; i <= to; i++) yield i;
  },
  'count.fail': async function* () {
    yield 1;
    await sleep(20); // after the headers: the error can only travel in the END frame
    throw new ApueError(409, 'Conflict', 'midway');
  },
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'echo.bidi': async function* (inputs) {
    for await (const { n } of inputs) yield { n: n * 2 };
  },
  'files.echo': ({ data }) => ({ data, size: data.byteLength }),
  'files.ingest': async ({ file }) => {
    const hash = createHash('sha256');
    for await (const chunk of file.stream()) hash.update(chunk);
    return { size: file.size, sha256: hash.digest('hex') };
  },
  'export.get': () => ({ archive: download.fromBytes(EXPORT, { type: 'application/x-test' }) }),
  'slow.get': async () => {
    await sleep(500);
    return 'late';
  },
  'class': () => ({ 'odd-key': null }),
};

const SCRIPT = `
import io, json, sys, hashlib
sys.path.insert(0, sys.argv[1])
import api
out = {}
def run(name, fn):
    try:
        out[name] = {"ok": fn()}
    except api.ApueError as e:
        out[name] = {"error": e.status, "type": e.type, "title": e.title, "detail": e.detail}
with api.Client(sys.argv[2], cafile=sys.argv[3]) as c:
    run("get", lambda: c.users_get({"id": "ab"}))
    run("void", lambda: c.users_none())
    run("keyword", lambda: getattr(c, "class_")())
    run("create", lambda: [c.orders_create({"item": "x"}, idempotency_key="k-py"), c.orders_create({"item": "x"}, idempotency_key="k-py"), c.orders_create({"item": "y"})])
    run("problem", lambda: c.orders_fail())
    run("validation", lambda: c.users_get({"id": 5}))
    run("stream", lambda: list(c.count_up({"to": 5})))
    seen = []
    run("stream_error", lambda: [seen.append(x) for x in c.count_fail()])
    out["stream_error_seen"] = seen
    run("client_stream", lambda: c.sum_client(iter([1, 2, 3, 4])))
    run("bidi", lambda: list(c.echo_bidi(iter([{"n": 1}, {"n": 2}]))))
    big = bytes(range(256)) * 4096 + b"{\\"$blob\\": 1}"
    run("bytes", lambda: (lambda r: [r["size"], hashlib.sha256(r["data"]).hexdigest(), hashlib.sha256(big).hexdigest()])(c.files_echo({"data": big})))
    run("file_bytes", lambda: c.files_ingest({"file": b"hello file"}))
    run("file_stream", lambda: c.files_ingest({"file": io.BytesIO(b"x" * 300000)}))
    d = c.export_get()["archive"]
    run("download", lambda: [type(d).__name__, d.url.startswith(sys.argv[2] + "/$downloads/"), d.size, d.type, hashlib.sha256(d.read()).hexdigest()])
    def batch_bytes():
        b = c.batch()
        first, second = b.files_echo({"data": big}), b.files_echo({"data": b"two"})
        b.send()
        return [first.result()["data"] == big, second.result()]
    run("batch_bytes", lambda: (lambda r: [r[0], r[1]["size"], r[1]["data"].decode()])(batch_bytes()))
    run("deadline", lambda: c.slow_get(timeout_ms=50))
    run("after_errors", lambda: c.users_get({"id": "zz"})["id"])
print(json.dumps(out))
`;

/** A temp dir with the CA and `api.py` generated through the CLI, like a user would (manifest over HTTPS). */
async function generated(ctx: TestContext, url: string): Promise<{ dir: string; ca: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'apue-python-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const ca = join(dir, 'ca.pem');
  writeFileSync(ca, testCert().cert);
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'apue-types.ts'), url, '--lang', 'python', '--ca', ca, '--out', join(dir, 'api.py')]);
  execFileSync(python!, ['-m', 'py_compile', join(dir, 'api.py')]);
  return { dir, ca };
}

test('a generated Python client against a live server', { skip: python ? false : 'python3 ≥ 3.11 not installed' }, async (ctx) => {
  const server = await startServer(api, handlers, { uploads: {} });
  ctx.after(() => server.close());
  const { dir, ca } = await generated(ctx, server.url);
  writeFileSync(join(dir, 'run.py'), SCRIPT);
  const { stdout } = await promisify(execFile)(python!, [join(dir, 'run.py'), dir, server.url, ca], { timeout: 60_000 });
  const out = JSON.parse(stdout) as Record<string, { ok?: unknown; error?: number; type?: string; title?: string; detail?: string }>;
  assert.deepEqual(out.get, { ok: { id: 'ab', role: 'member', tags: ['a'] } });
  assert.deepEqual(out.void, { ok: 'none' });
  assert.deepEqual(out.keyword, { ok: { 'odd-key': null } });
  const [first, replay, other] = out.create!.ok as number[];
  assert.equal(replay, first, 'same Idempotency-Key: the stored result');
  assert.equal(other, first! + 1);
  assert.deepEqual(out.problem, { error: 409, type: 'https://example.com/problems/out-of-stock', title: 'Out Of Stock', detail: 'item gone' });
  assert.equal(out.validation!.error, 400);
  assert.deepEqual(out.stream, { ok: [1, 2, 3, 4, 5] });
  assert.deepEqual([out.stream_error!.error, out.stream_error!.detail, out.stream_error_seen], [409, 'midway', [1]]);
  assert.deepEqual(out.client_stream, { ok: 10 });
  assert.deepEqual(out.bidi, { ok: [{ n: 2 }, { n: 4 }] });
  const [size, echoed, sent] = out.bytes!.ok as [number, string, string];
  assert.equal(size, 256 * 4096 + 12);
  assert.equal(echoed, sent, 'bytes through an upload in and BLOB frames out, $blob look-alike intact');
  assert.deepEqual(out.file_bytes, { ok: { size: 10, sha256: createHash('sha256').update('hello file').digest('hex') } });
  assert.deepEqual(out.file_stream, { ok: { size: 300000, sha256: createHash('sha256').update('x'.repeat(300000)).digest('hex') } });
  assert.deepEqual(out.download, { ok: ['Download', true, EXPORT.byteLength, 'application/x-test', createHash('sha256').update(EXPORT).digest('hex')] });
  assert.deepEqual(out.batch_bytes, { ok: [true, 3, 'two'] }, 'bytes in a batch: uploaded, and BLOB frames per lane');
  assert.equal(out.deadline!.error, 504);
  assert.deepEqual(out.after_errors, { ok: 'zz' }, 'the connection survives errors');
});

test('Python names: valid identifiers, keywords escaped', () => {
  assert.equal(pythonName('users.get'), 'users_get');
  assert.equal(pythonName('class'), 'class_');
  assert.equal(pythonName('3d.render'), '_3d_render');
  assert.equal(pythonName('a-b.c'), 'a_b_c');
  assert.equal(pythonName('batch'), 'batch_', 'client members are not shadowed');
  assert.equal(pythonName('close'), 'close_');
  const manifest = (ops: Record<string, Record<string, unknown>>) => ({ apue: 'test', ops: ops as never });
  const obj = (key: string) => ({ type: 'object', properties: { [key]: { type: 'string' } }, required: [key] });
  const one = { effect: 'safe', stream: 'none', output: { type: 'null' } };
  assert.throws(() => generatePython(manifest({ 'users.get': { ...one, input: obj('a') }, 'users_get': { ...one, input: obj('a') } })), /both be the Python method users_get/);
  // Same type name, different shapes: numbered; the same shape: shared.
  const code = generatePython(manifest({ 'a.b': { ...one, input: obj('x') }, 'aB': { ...one, input: obj('y') }, 'A.b': { ...one, input: obj('x') } }));
  assert.match(code, /^ABInput = TypedDict\("ABInput", \{"x": str\}\)$/m);
  assert.match(code, /^ABInput2 = TypedDict\("ABInput2", \{"y": str\}\)$/m);
  assert.match(code, /def aB\(self, input: ABInput2,/);
  assert.match(code, /def a_b\(self, input: ABInput,/);
});

// ---- resume, batches, compression, client-side validation ---------------------------------------

/** TCP proxy whose connections can be cut at once: a lost connection, as the client sees it. */
async function cuttingProxy(targetPort: number): Promise<{ port: number; cut(): void; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    port: (server.address() as net.AddressInfo).port,
    cut,
    close: () => new Promise((resolve) => (cut(), server.close(() => resolve()))),
  };
}

const CheckUser = t.object({
  name: t.string({ min: 2, max: 5, pattern: /^[a-z]+$/i }),
  age: t.number({ int: true, min: 0, max: 150 }),
  role: t.enum(['admin', 'member']),
  tags: t.array(t.string(), { max: 2 }),
  nick: t.optional(t.nullable(t.string())),
});
const api2 = defineApi({
  'events.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ n: t.number() }), output: t.number() }),
  'events.early': op({ effect: 'safe', stream: 'server', resumable: true, input: t.void(), output: t.number() }),
  'events.failing': op({ effect: 'safe', stream: 'server', resumable: true, input: t.void(), output: t.number() }),
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string({ min: 2 }) }), output: t.object({ id: t.string(), friends: t.array(t.string()) }) }),
  'orders.list': op({ effect: 'safe', input: t.object({ user: t.string() }), output: t.array(t.object({ id: t.string() })) }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.object({ id: t.number() }) }),
  'orders.fail': op({ effect: 'unsafe', input: t.void(), output: t.object({ x: t.string() }) }),
  'ticks': op({ effect: 'safe', stream: 'server', input: t.object({ n: t.number() }), output: t.number() }),
  'blob.get': op({ effect: 'safe', input: t.void(), output: t.object({ data: t.bytes() }) }),
  'echo.any': op({ effect: 'safe', input: t.object({ $ref: t.string() }), output: t.object({ $ref: t.string() }) }),
  'big.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'feed.live': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'feed.ack': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
  'check.user': op({ effect: 'unsafe', input: CheckUser, output: t.void() }),
  'check.letters': op({ effect: 'safe', input: t.object({ v: t.string({ pattern: /^\p{L}+$/u }) }), output: t.string() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'flaky.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
});

const SCRIPT2 = `
import json, sys, warnings
sys.path.insert(0, sys.argv[1])
import api
url, ca = sys.argv[2], sys.argv[3]
out = {}
def run(name, fn):
    try:
        out[name] = {"ok": fn()}
    except api.ApueError as e:
        out[name] = {"error": e.status, "type": e.type, "detail": e.detail, "fields": e.fields}
    except Exception as e:
        out[name] = {"raised": type(e).__name__}
codings = []
def client(**options):
    c = api.Client(url, cafile=ca, backoff=0.01, **options)
    original = c._request
    def request(method, path, headers, body):
        res = original(method, path, headers, body)
        codings.append([path.split("?")[0], res.coding])
        return res
    c._request = request
    return c
c, gz, plain = client(), client(accept_encoding="gzip"), client(accept_encoding="identity")

# Resumable streams through a proxy that loses the connection.
run("resume", lambda: list(c.events_watch({"n": 10})))
run("early", lambda: list(c.events_early()))
run("failing", lambda: list(c.events_failing()))

# Batches.
def res(call):
    try:
        return {"ok": call.result()}
    except api.ApueError as e:
        return {"error": e.status, "type": e.type}
def batch():
    b = c.batch()
    u = b.users_get({"id": "u1"})
    o = b.orders_list({"user": u.ref("id")})
    friend = b.users_get({"id": u.ref("friends", 0)})
    f = b.orders_fail()
    d = b.orders_list({"user": f.ref("x")})
    w = b.orders_create({"item": "pen"}, idempotency_key="batch-key-1")
    s = b.ticks({"n": 3})
    blob = b.blob_get()
    lit = b.echo_any({"$ref": "not a ref"})
    b.send()
    return {"user": res(u), "orders": res(o), "friend": res(friend), "fail": res(f), "dependent": res(d), "create": res(w),
            "ticks": list(s), "blob": blob.result()["data"].hex(), "lit": res(lit)}
run("batch", batch)
def replay():
    b = c.batch()
    w = b.orders_create({"item": "pen"}, idempotency_key="batch-key-1")
    b.send()
    return w.result()
run("batch_replay", replay)
def safe_batch():
    b = c.batch()
    u = b.users_get({"id": "u2"})
    o = b.orders_list({"user": u.ref("id")})
    b.send()
    return o.result()
run("batch_safe", safe_batch)
run("batch_invalid", lambda: c.batch().users_get({"id": 5}))
def forward():
    b = c.batch()
    b.users_get({"id": api.BatchCall(3).ref("id")})
run("batch_forward_ref", forward)

# Compression: negotiated codings, decoded incrementally.
run("big_default", lambda: len(c.big_get()))
run("big_gzip", lambda: len(gz.big_get()))
run("big_identity", lambda: len(plain.big_get()))
def live(streaming, other):
    it = streaming.feed_live()
    first = next(it)  # only possible if the stream is decoded as it arrives
    other.feed_ack()
    return [first, *it]
run("live_gzip", lambda: live(gz, c))
run("live_default", lambda: live(c, gz))
out["accept_encoding"] = api.ACCEPT_ENCODING

# Client-side validation: no request for invalid input.
run("invalid_user", lambda: c.check_user({"name": "x", "age": 1.5, "role": "boss", "tags": ["a", "b", "c"], "nick": 5}))
run("invalid_missing", lambda: c.check_user({}))
run("invalid_type", lambda: c.check_user("nope"))
run("invalid_pattern", lambda: c.check_user({"name": "ab1", "age": 3, "role": "admin", "tags": []}))
run("valid_stripped", lambda: c.users_get({"id": "u3", "extra": 1}))
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    run("deferred", lambda: c.check_letters({"v": "123"}))
out["warnings"] = [str(w.message) for w in caught]
run("invalid_stream", lambda: c.sum_client(iter([1, "x"])))
run("after_invalid_stream", lambda: c.sum_client(iter([1, 2])))

# Reads too long for a GET URL go as QUERY; a retryable 409 is retried.
run("long_read", lambda: c.users_get({"id": "x" * 3000})["id"] == "x" * 3000)
run("retryable", lambda: c.flaky_get())
out["codings"] = codings
for each in (c, gz, plain):
    each.close()
print(json.dumps(out))
`;

test('Python: resume, batches, compression, client-side validation', { skip: python ? false : 'python3 ≥ 3.11 not installed' }, async (ctx) => {
  const attempts: Array<string | null> = [];
  const requests: string[] = [];
  const acceptEncodings: string[] = [];
  let early = 0;
  let failing = 0;
  let created = 0;
  let flaky = 0;
  const incremental: string[] = [];
  let ack: (() => void) | undefined;
  let proxy: Awaited<ReturnType<typeof cuttingProxy>> | undefined;
  const handlers2: Handlers<typeof api2> = {
    'events.watch': async function* ({ n }, call) {
      attempts.push(call.resumeFrom ?? null);
      const attempt = attempts.length;
      for (let i = call.resumeFrom === undefined ? 0 : Number(call.resumeFrom) + 1; i < n; i++) {
        yield i;
        if (i % 3 === 2) call.checkpoint(String(i)); // several items per checkpoint: the client must skip
        // The connection is lost twice: two items past a checkpoint, then during the replay.
        if ((attempt === 1 && i === 4) || (attempt === 2 && i === 3)) {
          await sleep(100); // everything so far has reached the client
          proxy!.cut();
          return;
        }
      }
    },
    'events.early': async function* () {
      early++;
      yield 0; // no checkpoint yet: nothing to resume from
      await sleep(100);
      proxy!.cut();
    },
    'events.failing': async function* (_input, call) {
      failing++;
      yield 1;
      call.checkpoint('1');
      await sleep(20);
      throw new ApueError(409, 'Conflict', 'failed on purpose'); // an END error is final
    },
    'users.get': ({ id }) => ({ id, friends: ['b'] }),
    'orders.list': ({ user }) => [{ id: `${user}-o1` }],
    'orders.create': () => ({ id: ++created }),
    'orders.fail': () => {
      throw new ApueError(409, 'Out Of Stock', 'gone');
    },
    'ticks': async function* ({ n }) {
      for (let i = 0; i < n; i++) yield i;
    },
    'blob.get': () => ({ data: new Uint8Array([1, 2, 3]) }),
    'echo.any': (input) => input,
    'big.get': (_input, call) => {
      acceptEncodings.push(String(call.headers['accept-encoding']));
      return 'apü '.repeat(2000);
    },
    'feed.live': async function* () {
      yield 1;
      // The client acks once it has decoded item 1 — while this response is still open.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ApueError(408, 'No Ack', 'item 1 was not seen in time')), 5000);
        ack = () => (clearTimeout(timer), resolve());
      });
      yield 2;
    },
    'feed.ack': () => {
      ack?.();
    },
    'check.user': () => undefined,
    'check.letters': ({ v }) => v,
    'sum.client': async (inputs, call) => {
      incremental.push(String(call.headers.incremental));
      let sum = 0;
      for await (const n of inputs) sum += n;
      return sum;
    },
    'flaky.get': () => {
      if (++flaky === 1) throw new ApueError(409, 'Conflict', 'try again', { retryable: true });
      return 'second time';
    },
  };
  const server = await startServer(api2, handlers2, {
    principal: ({ method, url }) => {
      requests.push(`${method} ${url}`); // every op and batch request that reached the server
      return undefined;
    },
  });
  proxy = await cuttingProxy(Number(new URL(server.url).port));
  ctx.after(async () => {
    await proxy!.close();
    await server.close();
  });
  const { dir, ca } = await generated(ctx, server.url);
  writeFileSync(join(dir, 'run2.py'), SCRIPT2);
  const { stdout } = await promisify(execFile)(python!, [join(dir, 'run2.py'), dir, `https://127.0.0.1:${proxy.port}`, ca], { timeout: 60_000 });
  const out = JSON.parse(stdout) as Record<string, any>;
  const sent = (op: string) => requests.filter((r) => r.split(/[ ?]/)[1] === `/${op}`);

  // Resume: every item exactly once, in order, across two lost connections (the second during the replay).
  assert.deepEqual(out.resume, { ok: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  assert.deepEqual(attempts, [null, '2', '2']);
  assert.equal(sent('events.watch').length, 3);
  assert.deepEqual([out.early.raised !== undefined, early], [true, 1], 'no checkpoint: not resumed');
  assert.deepEqual([out.failing.error, out.failing.detail, failing], [409, 'failed on purpose', 1], 'an END error is not resumed');

  // Batches: refs, a failed call and its dependent, keys, a stream lane, bytes, an escaped look-alike.
  assert.deepEqual(out.batch.ok, {
    user: { ok: { id: 'u1', friends: ['b'] } },
    orders: { ok: [{ id: 'u1-o1' }] },
    friend: { error: 400, type: 'https://apue.dev/problems/validation-failed' },
    fail: { error: 409, type: 'about:blank' },
    dependent: { error: 424, type: 'https://apue.dev/problems/failed-dependency' },
    create: { ok: { id: 1 } },
    ticks: [0, 1, 2],
    blob: '010203',
    lit: { ok: { $ref: 'not a ref' } },
  });
  assert.deepEqual(out.batch_replay, { ok: { id: 1 } }, 'same per-call key: the stored result');
  assert.equal(created, 1);
  assert.deepEqual(out.batch_safe, { ok: [{ id: 'u2-o1' }] });
  assert.deepEqual(sent('$batch').map((r) => r.split(' ')[0]), ['POST', 'POST', 'QUERY'], 'QUERY only when every call is safe');
  assert.equal(out.batch_invalid.error, 400);
  assert.deepEqual(out.batch_forward_ref, { raised: 'ValueError' });

  // Compression: zstd where Python has it (3.14+), else gzip; identity on request; streams decoded as they arrive.
  const zstd = out.accept_encoding === 'zstd, gzip';
  const coding = (op: string) => (out.codings as Array<[string, string]>).filter(([path]) => path === `/${op}`).map(([, c]) => c);
  assert.deepEqual([out.big_default, out.big_gzip, out.big_identity], [{ ok: 8000 }, { ok: 8000 }, { ok: 8000 }]);
  assert.deepEqual(coding('big.get'), [zstd ? 'zstd' : 'gzip', 'gzip', 'identity']);
  assert.deepEqual(acceptEncodings, [out.accept_encoding, 'gzip', 'identity'], 'what the server was offered');
  assert.deepEqual([out.live_gzip, out.live_default], [{ ok: [1, 2] }, { ok: [1, 2] }]);
  assert.deepEqual(coding('feed.live'), ['gzip', zstd ? 'zstd' : 'gzip']);
  assert.ok(coding('events.watch').every((c) => c === (zstd ? 'zstd' : 'gzip')), 'resumed through compressed streams');

  // Validation: problems shaped like the server's, raised before any request.
  const issues = (value: unknown) => {
    try {
      CheckUser.parse(value);
      return [];
    } catch (error) {
      return (error as { issues: unknown[] }).issues;
    }
  };
  const problem = (value: unknown) => ({ error: 400, type: 'https://apue.dev/problems/validation-failed', detail: 'input does not match the schema', fields: issues(value) });
  assert.deepEqual(out.invalid_user, problem({ name: 'x', age: 1.5, role: 'boss', tags: ['a', 'b', 'c'], nick: 5 }));
  assert.equal(out.invalid_user.fields.length, 5);
  assert.deepEqual(out.invalid_missing, problem({}));
  assert.deepEqual(out.invalid_type, problem('nope'));
  assert.deepEqual(out.invalid_pattern, problem({ name: 'ab1', age: 3, role: 'admin', tags: [] }));
  assert.deepEqual(sent('check.user'), [], 'no invalid input reached the server');
  assert.deepEqual(out.valid_stripped, { ok: { id: 'u3', friends: ['b'] } });
  assert.ok(sent('users.get').some((r) => r.includes(encodeURIComponent('{"id":"u3"}'))), 'unknown keys dropped (same GET URL as the TypeScript client)');
  // A pattern Python can't check (\p{…}) is left to the server, with a warning.
  assert.equal(out.deferred.error, 400);
  assert.equal(sent('check.letters').length, 1);
  assert.match(out.warnings.join('\n'), /\/\^\\p\{L\}\+\$\/u is not checked in Python/);
  assert.deepEqual([out.invalid_stream.error, out.invalid_stream.detail], [400, 'input message 1 does not match the schema']);
  assert.deepEqual(out.after_invalid_stream, { ok: 3 });
  assert.equal(incremental.at(-1), '?1', 'request streams are marked incremental (RFC 10036)');

  assert.deepEqual(out.long_read, { ok: true });
  assert.deepEqual(sent('users.get').map((r) => r.split(' ')[0]), ['GET', 'QUERY']);
  assert.deepEqual([out.retryable, flaky], [{ ok: 'second time' }, 2]);
});

// JavaScript RegExp semantics that a naive Python `re` port gets wrong, plus patterns it can't express.
const PATTERNS: Array<[RegExp, string[]]> = [
  [/^[a-z]+$/, ['abc', 'abc\n', 'ABC', '']], // Python's $ also matches before a final newline
  [/^a.c$/, ['abc', 'a\nc', 'a\u2028c', 'a\rc', 'a😀c']], // JS . excludes all line terminators; 😀 is two units
  [/^a.c$/s, ['a\nc', 'a\u2028c']],
  [/^a.c$/u, ['a😀c', 'abc']],
  [/^.{2}$/, ['😀', 'ab']],
  [/^.{2}$/u, ['😀', 'ab']],
  [/^[^a-z]+$/, ['ABC', 'aB', '😀']],
  [/^[😀]$/, ['😀', '\ud83d']],
  [/^[😀]$/u, ['😀']],
  [/^\d+$/, ['123', '١٢٣']], // Python's \d, \w, \s and \b are Unicode-aware
  [/^\w+$/, ['abc_1', 'é', 'ſ']],
  [/\bfoo\b/, ['a foo b', 'éfooé', 'xfoo']],
  [/^\s$/, ['\ufeff', '\x1c', ' ', '\u00a0', '\u2028']],
  [/^\S+$/, ['\x1c\x1d', 'ab']],
  [/^\W$/, ['é', 'a']],
  [/^[a\D]$/, ['a', '1', 'x', '😀']],
  [/^[^a\D]$/, ['a', '1', 'x']],
  [/^[^\D\S]$/, ['1', ' ', 'x']],
  [/^[\s\S]$/, ['\n']],
  [/^[\S-a]$/, ['-', 'x', ' ']],
  [/[\d-z]/, ['-', 'z', '5', 'a']],
  [/^ab$/m, ['x\rab', 'x\nab\ny', 'ab\u2029', 'xab']], // JS m: every line terminator
  [/^$/, ['', '\n']],
  [/^a|b$/, ['ax', 'xb', 'x']],
  [/^abc$/i, ['ABC', 'aBc', 'abd']],
  [/^[\w.-]+@[\w-]+\.[a-z]{2,}$/i, ['a.b@c.de', 'A@B.COM', 'x@y']],
  [/^[a-z]+$/iu, ['ABC', 'K', 'ſ']], // non-ASCII + i: left to the server
  [/^k$/i, ['K', 'K']],
  [/^s$/i, ['ſ', 'S']], // Python folds ſ to s, JavaScript (without u) doesn't
  [/^[a-z]$/i, ['ſ', 'q']],
  [/^K$/i, ['k', 'K']], // a non-ASCII pattern under i: left to the server
  [/^ı$/iu, ['i']],
  [/^[Ā-ſ]$/i, ['s', 'k']],
  [/^a{,2}$/, ['a{,2}', 'aa', '']], // a literal in JS, a quantifier in Python
  [/^a{2}$/, ['aa', 'a']],
  [/^a]$/, ['a]']],
  [/^a}$/, ['a}']],
  [/^[[a]$/, ['[', 'a']],
  [/^[\]]$/, [']']],
  [/^[a\-z]$/, ['-', 'b']],
  [/^[^]$/, ['\n', 'x']],
  [/^[]$/, ['', 'x']],
  [/^\u0041\x42\cJ$/, ['AB\n']],
  [/^\u{1F600}$/u, ['😀']],
  [/^\uD83D\uDE00$/u, ['😀']],
  [/^\A\Z$/, ['AZ', '']], // identity escapes in JS, anchors in Python
  [/^\k$/, ['k']],
  [new RegExp('^\\u12$'), ['u12']], // (Annex B escapes: TypeScript rejects them in literals)
  [new RegExp('^\\x4$'), ['x4']],
  [/^\0$/, ['\0']],
  [/^[\b]$/, ['\b']],
  [/^\D\B$/, ['x']],
  [/^\t\v\f\r\n$/, ['\t\v\f\r\n']],
  [/^(?<year>\d{4})-\d\d$/, ['2024-01', '2024-1']],
  [/^(?:ab)+$/, ['abab', 'aba']],
  [/^(?!x)\w$/, ['x', 'y']],
  [/^\/path\/$/, ['/path/']],
  [/^[.]$/, ['.', 'x']],
  [/^\$\^$/, ['$^']],
  [/^ #$/, [' #']],
  [/^[A-Z]$/v, ['A']],
  // Not expressible in Python's re: left to the server.
  [/^\p{L}+$/u, ['abc', '123']],
  [/(a)\1/, ['aa']],
  [/(?<=\d{2,3})x/, ['12x']],
  [/^\c1$/, ['\\c1']],
  [/^[[a-c]&&b]$/v, ['b']],
  [/^[\w--\d]$/v, ['a', '1']],
  [/^\p{Lu}$/v, ['A']],
  [/^(?i:a)b$/, ['Ab']],
];
const DEFERRED = ['/^\\p{L}+$/u', '/(a)\\1/', '/(?<=\\d{2,3})x/', '/^\\c1$/', '/^[[a-c]&&b]$/v', '/^[\\w--\\d]$/v', '/^\\p{Lu}$/v', '/^(?i:a)b$/'];

const SCHEMAS: Array<[Schema<unknown>, unknown[]]> = [
  [t.string({ min: 2, max: 3 }), ['a', 'ab', '😀', '😀😀', 'abcd', 5, null]], // lengths in UTF-16 units
  [t.number({ int: true, min: 0, max: 10 }), [1, 1.5, -1, 11, '1', true, null, 0.1, 10]],
  [t.number({ min: 0.5 }), [0.25, 0.5]],
  [t.enum(['a', 'b']), ['a', 'c', 1]],
  [t.array(t.string(), { max: 2 }), [['a'], ['a', 1], ['a', 'b', 'c'], ['a', 1, 2], 'x', {}]],
  [
    t.object({ a: t.string(), b: t.optional(t.nullable(t.number())), c: t.object({ d: t.array(t.boolean()) }) }),
    [{ a: 'x', c: { d: [true] }, extra: 1 }, {}, { a: 1, b: 'x', c: { d: [1, true, 'y'] } }, { a: 'x', b: null, c: { d: [] } }, null, [], 'x'],
  ],
  [t.void(), [null, 1]],
  [t.unknown(), [{ x: 1 }]],
  [t.boolean(), [true, 0]],
  [t.nullable(t.object({ a: t.string() })), [null, { a: 1 }]],
  [t.object({ f: t.file({ max: 3 }), b: t.bytes() }), [{ f: 1, b: 'x' }, {}]],
  ...PATTERNS.map(([pattern, values]): [Schema<unknown>, unknown[]] => [t.string({ pattern }), values]),
];

const PARITY = `
import json, sys, warnings
sys.path.insert(0, sys.argv[1])
warnings.simplefilter("ignore")
import runtime
out = []
for case in json.load(open(sys.argv[2], encoding="utf-8")):
    schema, issues = case["schema"], []
    value = runtime._check(schema, case["value"], [], issues)
    flags = schema.get("x-apue-flags", "")
    untranslatable = "pattern" in schema and runtime._js_regex(schema["pattern"], flags) is None
    deferred = "pattern" in schema and runtime._pattern_deferred(schema["pattern"], flags, case["value"])
    out.append({"issues": issues, "output": value, "deferred": deferred, "untranslatable": untranslatable})
numbers = [runtime.canonical_json(n) for n in json.load(open(sys.argv[3]))]
print(json.dumps({"cases": out, "numbers": numbers}))
`;
// Canonical JSON numbers (GET URLs are cache keys): ECMAScript formatting, not Python's repr.
const NUMBERS = [0, -0, 1, -1.5, 0.1, 1e-7, 1.5e-7, 0.000001, 123.456, 1e16, 1e21, 1.5e300, 2 ** 53, 5e-324, 1 / 3, -2.5e-10];

test('Python validation agrees with the TypeScript schemas (or leaves a pattern to the server)', { skip: python ? false : 'python3 ≥ 3.11 not installed' }, async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'apue-python-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = SCHEMAS.flatMap(([schema, values]) =>
    values.map((value) => {
      try {
        return { schema: schema.toJSONSchema(), value, issues: [], output: schema.parse(value) ?? null };
      } catch (error) {
        return { schema: schema.toJSONSchema(), value, issues: (error as { issues: unknown[] }).issues, output: null };
      }
    }),
  );
  writeFileSync(join(dir, 'runtime.py'), readFileSync(join(import.meta.dirname, '..', 'src', 'python', 'runtime.py')));
  writeFileSync(join(dir, 'parity.py'), PARITY);
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  // As floats, like JSON.parse gives them to JavaScript (Python would keep 1e16 an int otherwise).
  writeFileSync(join(dir, 'numbers.json'), `[${NUMBERS.map((n) => (Number.isInteger(n) ? `${BigInt(n)}.0` : String(n))).join(',')}]`);
  const { stdout } = await promisify(execFile)(python!, ['-B', join(dir, 'parity.py'), dir, join(dir, 'cases.json'), join(dir, 'numbers.json')]);
  const { cases: results, numbers } = JSON.parse(stdout) as {
    cases: Array<{ issues: unknown[]; output: unknown; deferred: boolean; untranslatable: boolean }>;
    numbers: string[];
  };
  assert.deepEqual(numbers, NUMBERS.map((n) => JSON.stringify(n)));
  const untranslatable = new Set<string>();
  results.forEach((py, i) => {
    const { schema, value, issues, output } = cases[i]!;
    const what = `${JSON.stringify(schema)} with ${JSON.stringify(value)}`;
    if (py.untranslatable) untranslatable.add(`/${schema.pattern}/${schema['x-apue-flags'] ?? ''}`);
    const ascii = (text: unknown) => typeof text === 'string' && /^[\x00-\x7f]*$/.test(text) && !/\\u/.test(text);
    if (!py.untranslatable && ascii(schema.pattern) && ascii(value)) assert.equal(py.deferred, false, `${what}: checked in Python`);
    if (py.deferred) return assert.deepEqual(py.issues, [], `${what}: left to the server`);
    assert.deepEqual(py.issues, issues, what);
    if (issues.length === 0) assert.deepEqual(py.output, output, `${what}: normalised like the server`);
  });
  assert.deepEqual([...untranslatable], DEFERRED, 'exactly these patterns are left to the server');
});
