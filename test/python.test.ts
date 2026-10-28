// Python clients generated from the manifest (`apue-types --lang python`): a real Python 3 process
// calls a real server — unary, streams, errors, idempotency, deadlines, bytes, uploads, downloads.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { defineApi, op } from '../src/api.ts';
import { pythonName } from '../src/codegen-python.ts';
import { download } from '../src/downloads.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const python = (() => {
  try {
    const version = execFileSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' }).trim();
    return version === 'True' ? 'python3' : undefined;
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
    run("deadline", lambda: c.slow_get(timeout_ms=50))
    run("after_errors", lambda: c.users_get({"id": "zz"})["id"])
print(json.dumps(out))
`;

test('a generated Python client against a live server', { skip: python ? false : 'python3 ≥ 3.11 not installed' }, async (ctx) => {
  const server = await startServer(api, handlers, { uploads: {} });
  const dir = mkdtempSync(join(tmpdir(), 'apue-python-'));
  ctx.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ca = join(dir, 'ca.pem');
  writeFileSync(ca, testCert().cert);
  writeFileSync(join(dir, 'run.py'), SCRIPT);
  // Through the CLI, like a user: manifest over HTTPS → api.py.
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'apue-types.ts'), server.url, '--lang', 'python', '--ca', ca, '--out', join(dir, 'api.py')]);
  execFileSync(python!, ['-m', 'py_compile', join(dir, 'api.py')]);
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
  assert.equal(out.deadline!.error, 504);
  assert.deepEqual(out.after_errors, { ok: 'zz' }, 'the connection survives errors');
});

test('Python names: valid identifiers, keywords escaped', () => {
  assert.equal(pythonName('users.get'), 'users_get');
  assert.equal(pythonName('class'), 'class_');
  assert.equal(pythonName('3d.render'), '_3d_render');
  assert.equal(pythonName('a-b.c'), 'a_b_c');
});
