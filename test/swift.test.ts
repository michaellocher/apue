// Swift clients generated from the manifest (`apue-types --lang swift`): a compiled Swift program
// calls a real server over HTTP/2 (URLSession, pinned self-signed certificate) — unary, streams,
// full-duplex bidi, errors, idempotency, retries, deadlines, cancellation, bytes, uploads, downloads.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { canonicalJson, defineApi, op, readPath } from '../src/api.ts';
import { generateSwift, swiftName } from '../src/codegen-swift.ts';
import { download } from '../src/downloads.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { sleep, testCert } from './helpers.ts';

const swiftc = (() => {
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
    return 'swiftc';
  } catch {
    return undefined;
  }
})();

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string({ min: 2 }) }), output: t.object({ id: t.string(), role: t.enum(['admin', 'member']), tags: t.optional(t.array(t.string())) }) }),
  'users.none': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'nulls.echo': op({
    effect: 'safe',
    input: t.object({ a: t.nullable(t.number()), b: t.optional(t.nullable(t.string())), c: t.optional(t.string()) }),
    output: t.object({ a: t.nullable(t.number()), b: t.optional(t.nullable(t.string())), state: t.string() }),
  }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'orders.fail': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number() }), output: t.number() }),
  'count.fail': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'ticks': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'ticks.aborted': op({ effect: 'safe', input: t.void(), output: t.number() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'sink.fail': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'echo.bidi': op({ effect: 'unsafe', stream: 'bidi', input: t.object({ n: t.number() }), output: t.object({ n: t.number() }) }),
  'files.echo': op({ effect: 'unsafe', input: t.object({ data: t.bytes(), meta: t.unknown() }), output: t.object({ data: t.bytes(), size: t.number(), meta: t.unknown() }) }),
  'blobs.sum': op({ effect: 'unsafe', stream: 'client', input: t.object({ data: t.bytes(), tag: t.unknown() }), output: t.object({ sizes: t.array(t.number()), tags: t.array(t.unknown()), sha256: t.string() }) }),
  'files.ingest': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.object({ size: t.number(), sha256: t.string() }) }),
  'export.get': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download() }) }),
  'export.bad': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download() }) }),
  'flaky.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'slow.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'class': op({ effect: 'safe', input: t.void(), output: t.object({ 'odd-key': t.nullable(t.number()), self: t.optional(t.string()), in: t.unknown() }) }),
});
const EXPORT = new Uint8Array(3 * 1024 * 1024 + 3).map((_, i) => (i * 7) % 251);
const state = { orders: 0, flaky: 0, tickAborts: 0, slowAborts: 0 };
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id, role: 'member', tags: ['a'] }),
  'users.none': () => 'none',
  'nulls.echo': (input) => ({ a: input.a, ...('b' in input ? { b: input.b } : {}), state: !('b' in input) ? 'absent' : input.b === null ? 'null' : 'value' }),
  'orders.create': () => ++state.orders,
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
  'ticks': async function* (_input, ctx) {
    ctx.signal.addEventListener('abort', () => state.tickAborts++);
    for (let i = 0; !ctx.signal.aborted; i++) {
      yield i;
      await sleep(10);
    }
  },
  'ticks.aborted': () => state.tickAborts,
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'sink.fail': async (inputs) => {
    for await (const _n of inputs) throw new ApueError(403, 'Forbidden', 'no streams for you');
    return 0;
  },
  'echo.bidi': async function* (inputs) {
    for await (const { n } of inputs) yield { n: n * 2 };
  },
  'files.echo': ({ data, meta }) => ({ data, size: data.byteLength, meta }),
  'blobs.sum': async (inputs) => {
    const hash = createHash('sha256');
    const sizes: number[] = [];
    const tags: unknown[] = [];
    for await (const { data, tag } of inputs) {
      hash.update(data);
      sizes.push(data.byteLength);
      tags.push(tag);
    }
    return { sizes, tags, sha256: hash.digest('hex') };
  },
  'files.ingest': async ({ file }) => {
    const hash = createHash('sha256');
    for await (const chunk of file.stream()) hash.update(chunk);
    return { size: file.size, sha256: hash.digest('hex') };
  },
  'export.get': () => ({ archive: download.fromBytes(EXPORT, { type: 'application/x-test' }) }),
  'export.bad': () => ({ archive: { ...download.fromBytes(new Uint8Array(1000)), sha256: '0'.repeat(64) } }),
  'flaky.get': () => {
    if (++state.flaky === 1) throw new ApueError(503, 'Service Unavailable', 'warming up', { retryable: true }, { 'retry-after': '1' });
    return 'ok';
  },
  'slow.get': async (_input, ctx) => {
    ctx.signal.addEventListener('abort', () => state.slowAborts++);
    await sleep(500);
    return 'late';
  },
  'class': () => ({ 'odd-key': null, self: 'me', in: { list: [1, 'x', null, true] } }),
};

/** TCP proxy that cuts its first connection once `cutAfter` bytes went from server to client. */
async function cuttingProxy(targetPort: number, cutAfter: number) {
  const sockets = new Set<net.Socket>();
  const stats = { connections: 0, toClient: 0 };
  const server = net.createServer((client) => {
    const n = ++stats.connections;
    const upstream = net.connect(targetPort, '127.0.0.1');
    let relayed = 0;
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => {});
      s.on('close', () => (sockets.delete(s), client.destroy(), upstream.destroy()));
    }
    client.on('data', (chunk) => upstream.write(chunk));
    upstream.on('data', (chunk: Buffer) => {
      stats.toClient += chunk.byteLength;
      relayed += chunk.byteLength;
      client.write(chunk);
      if (n === 1 && relayed > cutAfter) (client.destroy(), upstream.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    stats,
    close: () => new Promise<void>((resolve) => (sockets.forEach((s) => s.destroy()), server.close(() => resolve()))),
  };
}

const MAIN = String.raw`
import Foundation
import CryptoKit

let args = CommandLine.arguments
let pem = try String(contentsOfFile: args[2], encoding: .utf8)
let c = try Client(baseURL: URL(string: args[1])!, options: .init(pinnedCertificates: [pem]))
let viaProxy = try Client(baseURL: URL(string: args[3])!, options: .init(pinnedCertificates: [pem], backoff: 0.05))
let dir = URL(fileURLWithPath: args[4])
var out: [String: JSONValue] = [:]

func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func json<T: Encodable>(_ value: T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
func inputs<T: Sendable>(_ items: [T]) -> AsyncStream<T> {
  AsyncStream { continuation in
    for item in items { continuation.yield(item) }
    continuation.finish()
  }
}

@MainActor func run(_ name: String, _ body: () async throws -> JSONValue) async {
  do {
    out[name] = ["ok": try await body()]
  } catch let error as ApueError {
    out[name] = ["error": .number(Double(error.status)), "type": .string(error.type), "title": .string(error.title), "detail": error.detail.map { .string($0) } ?? .null]
  } catch {
    out[name] = ["exception": .string(String(describing: error))]
  }
}

await run("get") { try json(await c.usersGet(.init(id: "ab"))) }
await run("void") { .string(try await c.usersNone()) }
await run("keyword") {
  let value = try await c.` + '`class`' + String.raw`()
  return ["odd": value.oddKey.map { .number($0) } ?? .null, "self": .string(value.self_ ?? "-"), "in": value.` + '`in`' + String.raw`]
}
await run("nulls") {
  func describe(_ b: String??) -> JSONValue {
    switch b {
    case .none: return .string("absent")
    case .some(.none): return .string("null")
    case .some(.some(let text)): return .string(text)
    }
  }
  var rows: [JSONValue] = []
  for input in [NullsEchoInput(a: nil), NullsEchoInput(a: 1, b: .some(nil)), NullsEchoInput(a: 2.5, b: "x", c: "y")] {
    let r = try await c.nullsEcho(input)
    rows.append([r.a.map { .number($0) } ?? .null, describe(r.b), .string(r.state)])
  }
  return .array(rows)
}
await run("create") {
  let first = try await c.ordersCreate(.init(item: "x"), idempotencyKey: "k-swift")
  let replay = try await c.ordersCreate(.init(item: "x"), idempotencyKey: "k-swift")
  let other = try await c.ordersCreate(.init(item: "y"))
  return [.number(first), .number(replay), .number(other)]
}
await run("problem") { try await c.ordersFail(); return .null }
await run("validation") { try json(await c.usersGet(.init(id: "a"))) }
await run("stream") {
  var items: [JSONValue] = []
  for try await n in c.countUp(.init(to: 5)) { items.append(.number(n)) }
  return .array(items)
}
var seen: [JSONValue] = []
await run("stream_error") {
  for try await n in c.countFail() { seen.append(.number(n)) }
  return .null
}
out["stream_error_seen"] = .array(seen)
await run("client_stream") { .number(try await c.sumClient(inputs([1, 2, 3, 4]))) }
struct Boom: Error {}
await run("input_error") {
  .number(try await c.sumClient(AsyncThrowingStream<Double, Error> { continuation in
    continuation.yield(1)
    continuation.finish(throwing: Boom())
  }))
}
await run("early_reject") {
  // The server answers while inputs keep coming; when the body stops being read is a race: repeat.
  var outcomes: [JSONValue] = []
  for _ in 0..<5 {
    do {
      outcomes.append(.number(try await c.sinkFail(AsyncStream(unfolding: { 1.0 }))))  // endless inputs
    } catch let error as ApueError {
      outcomes.append(.string("\(error.status) \(error.detail ?? "")"))
    } catch {
      outcomes.append(.string(String(describing: error)))
    }
  }
  return .array(outcomes)
}
await run("bidi") {
  // Ping-pong: the next input is only sent after the previous output arrived (full duplex).
  let (requests, feed) = AsyncStream.makeStream(of: EchoBidiInput.self)
  feed.yield(.init(n: 1))
  var got: [JSONValue] = []
  for try await output in c.echoBidi(requests) {
    got.append(.number(output.n))
    if got.count < 3 { feed.yield(.init(n: Double(got.count + 1))) } else { feed.finish() }
  }
  return .array(got)
}
var big = Data((0..<(256 * 4096)).map { UInt8(truncatingIfNeeded: $0) })
big.append(Data("{\"$blob\": 1}".utf8))
await run("bytes") {
  let r = try await c.filesEcho(.init(data: big, meta: ["$blob": 0]))
  return [.number(r.size), .string(hex(r.data)), .string(hex(big)), r.meta]
}
await run("blobs") {
  let r = try await c.blobsSum(inputs([
    BlobsSumInput(data: Data([1, 2, 3]), tag: ["$blob": 5]),
    BlobsSumInput(data: Data(repeating: 7, count: 100_000), tag: ["$lit": 1]),
    BlobsSumInput(data: Data(), tag: "x"),
  ]))
  return [.array(r.sizes.map { .number($0) }), .array(r.tags), .string(r.sha256)]
}
await run("file_bytes") { try json(await c.filesIngest(.init(file: .data(Data("hello file".utf8))))) }
let path = dir.appendingPathComponent("upload.bin")
try Data(repeating: 0x78, count: 300_000).write(to: path)
await run("file_url") { try json(await c.filesIngest(.init(file: .file(path)))) }
await run("download") {
  let d = try await c.exportGet().archive
  let bytes = try await d.bytes()
  return [.string("\(type(of: d))"), .bool(d.url.absoluteString.hasPrefix(args[1] + "/$downloads/")), .number(Double(d.size)), .string(d.type), .string(hex(bytes)), .bool(d.expiresAt != nil)]
}
await run("download_resume") { .string(hex(try await viaProxy.exportGet().archive.bytes())) }
await run("download_bad") { _ = try await c.exportBad().archive.bytes(); return .null }
await run("deadline") { .string(try await c.slowGet(timeoutMs: 50)) }
await run("retry_after") {
  let start = Date()
  let value = try await c.flakyGet()
  return [.string(value), .number(Date().timeIntervalSince(start))]
}
await run("cancel_stream") {
  var count = 0
  for try await _ in c.ticks() {
    count += 1
    if count == 3 { break }
  }
  try await Task.sleep(nanoseconds: 100_000_000)
  return [.number(Double(count)), .number(try await c.ticksAborted())]  // while this process still runs
}
await run("cancel_task") {
  let task = Task { try await c.slowGet() }
  try await Task.sleep(nanoseconds: 100_000_000)
  task.cancel()
  do {
    _ = try await task.value
    return "completed"
  } catch is CancellationError {
    return "cancelled"
  }
}
await run("after_errors") { .string(try await c.usersGet(.init(id: "zz")).id) }
// Pinning: another certificate is refused, and without pins the system store decides (also refused).
let wrongPin = try Client(baseURL: URL(string: args[1])!, options: .init(pinnedCertificates: [try String(contentsOfFile: args[5], encoding: .utf8)], retries: 0))
await run("wrong_pin") { .string(try await wrongPin.usersNone()) }
let unpinned = try Client(baseURL: URL(string: args[1])!, options: .init(retries: 0))
await run("no_pin") { .string(try await unpinned.usersNone()) }

let lengths = [0, 1, 55, 56, 63, 64, 65, 1000, 200_000]
out["portable_sha256"] = .bool(lengths.allSatisfy { n in
  let data = Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 31) })
  var hasher = PortableSHA256()
  hasher.update(data.prefix(n / 3))
  hasher.update(data.dropFirst(n / 3))
  return hasher.hex() == hex(data)
})
let canonicalInput: JSONValue = [
  "b": [1, 1e21, 1e-7, 0.1, -0.0, 123456789012, 1.5e300, 5e-324, 1e20, 100, -2.5e-8, 0.000001],
  "a": "é\u{1F600}\u{FF61}\n\"\\\u{01}\u{7F}", "\u{FF61}": 1, "\u{1F600}": 2, "aa": nil, "A": true, "": [:],
]
out["canonical"] = .string(try JSONText.string(Node(canonicalInput), canonical: true))
print(String(decoding: try JSONEncoder().encode(JSONValue.object(out)), as: UTF8.self))
`;

// The test trusts the server's self-signed certificate by pinning it, which the runtime implements
// on Apple platforms only (Security framework); on Linux the generated client is untested.
const skipReason = !swiftc ? 'swiftc not installed' : process.platform !== 'darwin' ? 'certificate pinning (needed for the test server) is Apple-only' : false;
test('a generated Swift client against a live server', { skip: skipReason, timeout: 600_000 }, async (ctx) => {
  const { key, cert } = testCert();
  const apue = createApueServer(api, handlers, { key, cert, uploads: {} });
  const sessions = new Set<unknown>(); // HTTP/2 connections the Swift program used
  const requests: Array<{ method: string; path: string; key?: string; range?: string; ifRange?: string; uploadComplete?: string; uploadInterop?: string }> = [];
  apue.server.on('stream', (stream, headers) => {
    if (!String(headers['user-agent']).startsWith('node')) sessions.add(stream.session); // not the CLI
    requests.push({
      method: String(headers[':method']),
      path: String(headers[':path']),
      key: headers['idempotency-key'] as string | undefined,
      range: headers['range'] as string | undefined,
      ifRange: headers['if-range'] as string | undefined,
      uploadComplete: headers['upload-complete'] as string | undefined,
      uploadInterop: headers['upload-draft-interop-version'] as string | undefined,
    });
  });
  const port = await apue.listen();
  const url = `https://127.0.0.1:${port}`;
  const proxy = await cuttingProxy(port, 1024 * 1024);
  const dir = mkdtempSync(join(tmpdir(), 'apue-swift-'));
  ctx.after(async () => {
    await proxy.close();
    await apue.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ca = join(dir, 'cert.pem');
  writeFileSync(ca, cert);
  const otherCert = join(dir, 'other.pem'); // a certificate the server doesn't have
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-keyout', join(dir, 'other.key'), '-out', otherCert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'main.swift'), MAIN);
  // The runtime template compiles on its own (Swift 6 language mode: strict concurrency).
  await promisify(execFile)(swiftc!, ['-swift-version', '6', '-typecheck', join(import.meta.dirname, '..', 'src', 'swift', 'Runtime.swift')]);
  // Through the CLI, like a user: manifest over HTTPS → Api.swift, compiled with a program using it.
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'apue-types.ts'), url, '--lang', 'swift', '--ca', ca, '--out', join(dir, 'Api.swift')]);
  await promisify(execFile)(swiftc!, ['-swift-version', '6', '-Onone', '-o', join(dir, 'run'), join(dir, 'Api.swift'), join(dir, 'main.swift')], { timeout: 300_000 });
  const { stdout } = await promisify(execFile)(join(dir, 'run'), [url, ca, `https://127.0.0.1:${proxy.port}`, dir, otherCert], { timeout: 60_000 });
  const out = JSON.parse(stdout) as Record<string, { ok?: any; error?: number; type?: string; title?: string; detail?: string; exception?: string } | any>;

  assert.deepEqual(out.get, { ok: { id: 'ab', role: 'member', tags: ['a'] } });
  assert.ok(requests.some((r) => r.method === 'GET' && r.path === readPath('users.get', { id: 'ab' })), 'cacheable read: GET ?i= with canonical JSON');
  assert.deepEqual(out.void, { ok: 'none' });
  assert.deepEqual(out.keyword, { ok: { odd: null, self: 'me', in: { list: [1, 'x', null, true] } } });
  assert.deepEqual(out.nulls, { ok: [[null, 'absent', 'absent'], [1, 'null', 'null'], [2.5, 'x', 'value']] }, 'absent vs null, both ways');
  const [first, replay, other] = out.create.ok as number[];
  assert.equal(replay, first, 'same Idempotency-Key: the stored result');
  assert.equal(other, first! + 1);
  const keys = requests.filter((r) => r.path === '/orders.create').map((r) => r.key);
  assert.deepEqual(keys.slice(0, 2), ['"k-swift"', '"k-swift"']);
  assert.match(keys[2]!, /^"[0-9a-f-]{36}"$/, 'a generated key for non-safe calls');
  assert.deepEqual(out.problem, { error: 409, type: 'https://example.com/problems/out-of-stock', title: 'Out Of Stock', detail: 'item gone' });
  assert.equal(out.validation.error, 400);
  assert.equal(out.validation.type, 'https://apue.dev/problems/validation-failed');
  assert.deepEqual(out.stream, { ok: [1, 2, 3, 4, 5] });
  assert.deepEqual([out.stream_error.error, out.stream_error.detail, out.stream_error_seen], [409, 'midway', [1]]);
  assert.deepEqual(out.client_stream, { ok: 10 });
  assert.deepEqual(out.input_error, { exception: 'Boom()' }, 'inputs that fail fail the call');
  assert.deepEqual(out.early_reject, { ok: Array(5).fill('403 no streams for you') }, 'a rejected request stream ends the call while inputs keep coming');
  assert.deepEqual(out.bidi, { ok: [2, 4, 6] }, 'full duplex: each output arrived before the next input was sent');
  const [size, echoed, sent, meta] = out.bytes.ok as [number, string, string, unknown];
  assert.equal(size, 256 * 4096 + 12);
  assert.equal(echoed, sent, 'bytes through an upload in and BLOB frames out');
  assert.deepEqual(meta, { $blob: 0 }, 'a $blob look-alike in JSON stays data');
  const blobData = Buffer.concat([Buffer.from([1, 2, 3]), Buffer.alloc(100_000, 7)]);
  assert.deepEqual(out.blobs, { ok: [[3, 100_000, 0], [{ $blob: 5 }, { $lit: 1 }, 'x'], createHash('sha256').update(blobData).digest('hex')] }, 'BLOB frames in a request stream');
  assert.deepEqual(out.file_bytes, { ok: { size: 10, sha256: createHash('sha256').update('hello file').digest('hex') } });
  assert.deepEqual(out.file_url, { ok: { size: 300_000, sha256: createHash('sha256').update('x'.repeat(300_000)).digest('hex') } });
  // One request with Upload-Complete: ?1 set by the runtime — without it, URLSession switches to its
  // own resumable-upload mode (Upload-Draft-Interop-Version: 6).
  const uploads = requests.filter((r) => r.method === 'POST' && r.path === '/$uploads' && r.uploadComplete === '?1' && r.uploadInterop === undefined).length;
  const deletes = requests.filter((r) => r.method === 'DELETE' && r.path.startsWith('/$uploads/')).length;
  assert.equal(uploads, 3);
  assert.equal(deletes, uploads, 'every upload made for a call is deleted after it');
  const exportHash = createHash('sha256').update(EXPORT).digest('hex');
  assert.deepEqual(out.download, { ok: ['Download', true, EXPORT.byteLength, 'application/x-test', exportHash, true] });
  assert.deepEqual(out.download_resume, { ok: exportHash });
  assert.equal(proxy.stats.connections, 2, 'the cut download continued on a new connection');
  assert.ok(proxy.stats.toClient < EXPORT.byteLength * 1.25, `resumed, not restarted (${proxy.stats.toClient} bytes relayed)`);
  assert.ok(requests.some((r) => r.path.startsWith('/$downloads/') && /^bytes=[1-9]\d*-$/.test(r.range ?? '') && r.ifRange), 'Range + If-Range');
  assert.equal(out.download_bad.error, 502, 'a SHA-256 mismatch is an error');
  assert.equal(out.deadline.error, 504);
  const [flaky, waited] = out.retry_after.ok as [string, number];
  assert.equal(flaky, 'ok');
  assert.equal(state.flaky, 2);
  assert.ok(waited >= 0.9, `Retry-After honoured (${waited} s)`);
  assert.deepEqual(out.cancel_stream, { ok: [3, 1] }, 'leaving a stream cancels it on the server at once');
  assert.deepEqual(out.cancel_task, { ok: 'cancelled' });
  await sleep(50);
  assert.equal(state.tickAborts, 1, 'leaving a stream cancels it on the server');
  assert.equal(state.slowAborts, 2, 'deadline and Task cancellation abort the handler');
  assert.deepEqual(out.after_errors, { ok: 'zz' });
  assert.equal(sessions.size - proxy.stats.connections, 1, 'one connection for everything, errors included');
  assert.match(out.wrong_pin.exception, /NSURLErrorDomain/, 'a certificate other than the pinned one is refused');
  assert.match(out.no_pin.exception, /NSURLErrorDomain/, 'without pins the system trust store decides');
  assert.equal(out.portable_sha256, true, 'the SHA-256 for platforms without CryptoKit');
  const canonicalInput = { b: [1, 1e21, 1e-7, 0.1, -0, 123456789012, 1.5e300, 5e-324, 1e20, 100, -2.5e-8, 0.000001], a: 'é\u{1F600}\u{FF61}\n"\\\u0001\u007f', '\u{FF61}': 1, '\u{1F600}': 2, aa: null, A: true, '': {} };
  assert.equal(out.canonical, canonicalJson(canonicalInput), 'RFC 8785: sorted by UTF-16 code units, ES numbers');
});

test('Swift names: valid identifiers, keywords escaped', () => {
  assert.equal(swiftName('users.get'), 'usersGet');
  assert.equal(swiftName('class'), '`class`');
  assert.equal(swiftName('3d.render'), '_3dRender');
  assert.equal(swiftName('a-b.c'), 'aBC');
  assert.equal(swiftName('init'), 'init_');
  assert.equal(swiftName('runtime'), 'runtime_');
});

test('Swift generator rejects schemas it cannot express', () => {
  const manifest = (input: object) => ({ apue: 'draft-00', ops: { 'x.y': { effect: 'safe', stream: 'none', input, output: { type: 'null' } } } });
  assert.throws(() => generateSwift(manifest({ type: 'string', format: 'email' })), /unsupported JSON Schema/);
  assert.throws(() => generateSwift(manifest({ anyOf: [{ type: 'string' }, { type: 'number' }] })), /unsupported JSON Schema/);
  assert.match(generateSwift(manifest({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })), /public struct XYInput: Codable, Sendable/);
});
