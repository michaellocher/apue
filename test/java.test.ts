// Java clients generated from the manifest (`apue-types --lang java`): javac compiles the generated
// file, a real JVM calls a real server through a TCP proxy that counts connections and cuts one —
// unary, streams, errors, idempotency, deadlines, retries, bytes, uploads, downloads (resumed).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { canonicalJson, defineApi, op } from '../src/api.ts';
import { generateJava, javaFieldName, javaMethodName, javaString } from '../src/codegen-java.ts';
import type { Manifest } from '../src/codegen.ts';
import { download } from '../src/downloads.ts';
import { ApueError } from '../src/protocol.ts';
import { t, type DownloadSource } from '../src/schema.ts';
import { buildManifest, type Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const run = promisify(execFile);
const javac = (() => {
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    execFileSync('java', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = javac ? false : 'javac/java (JDK 17+) not installed';
const ROOT = join(import.meta.dirname, '..');

const api = defineApi({
  'users.get': op({
    effect: 'safe',
    input: t.object({ id: t.string({ min: 2 }) }),
    output: t.object({ id: t.string(), role: t.enum(['admin', 'member']), tags: t.optional(t.array(t.string())), nick: t.optional(t.nullable(t.string())) }),
  }),
  'users.none': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string(), note: t.optional(t.string()) }), output: t.number({ int: true }) }),
  'orders.fail': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number({ int: true }) }), output: t.number() }),
  'count.fail': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'count.cancelled': op({ effect: 'safe', input: t.void(), output: t.boolean() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'echo.bidi': op({ effect: 'unsafe', stream: 'bidi', input: t.object({ n: t.number() }), output: t.object({ n: t.number() }) }),
  'files.echo': op({ effect: 'unsafe', input: t.object({ data: t.bytes(), meta: t.unknown() }), output: t.object({ data: t.bytes(), size: t.number({ int: true }), meta: t.unknown() }) }),
  'blobs.collect': op({
    effect: 'unsafe',
    stream: 'client',
    input: t.object({ chunk: t.bytes(), meta: t.unknown() }),
    output: t.object({ sizes: t.array(t.number({ int: true })), sha256: t.string(), metas: t.array(t.unknown()) }),
  }),
  'files.ingest': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.object({ size: t.number({ int: true }), sha256: t.string() }) }),
  'export.get': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download() }) }),
  'export.big': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download() }) }),
  'export.bad': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download() }) }),
  'slow.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'flaky.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'class': op({ effect: 'safe', input: t.void(), output: t.object({ 'odd-key': t.nullable(t.number()) }) }),
});

const EXPORT = new Uint8Array(2 * 1024 * 1024 + 3).map((_, i) => i % 253);
const BIG = new Uint8Array(4 * 1024 * 1024 + 5).map((_, i) => (i * 7) % 251);
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

function state() {
  return { orders: 0, flaky: 0, cancelled: false, ranges: [] as Array<{ start: number; end: number } | undefined>, armed: false, users: [] as Array<{ id: string; method: string; version: string; auth?: string }> };
}

function handlers(s: ReturnType<typeof state>): Handlers<typeof api> {
  return {
    'users.get': ({ id }, ctx) => {
      s.users.push({ id: id.length > 100 ? `long:${id.length}` : id, method: ctx.method, version: ctx.httpVersion, auth: ctx.headers.authorization });
      return { id, role: 'member', tags: ['a'], nick: null };
    },
    'users.none': () => 'none',
    'orders.create': () => ++s.orders,
    'orders.fail': () => {
      throw new ApueError(409, 'Out Of Stock', 'item gone', { type: 'https://example.com/problems/out-of-stock' });
    },
    'count.up': async function* ({ to }, ctx) {
      if (to > 1000) ctx.signal.addEventListener('abort', () => (s.cancelled = true));
      for (let i = 1; i <= to; i++) {
        yield i;
        if (i % 100 === 0) await sleep(1);
      }
    },
    'count.cancelled': () => s.cancelled,
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
    'files.echo': ({ data, meta }) => ({ data, size: data.byteLength, meta }),
    'blobs.collect': async (inputs) => {
      const hash = createHash('sha256');
      const sizes: number[] = [];
      const metas: unknown[] = [];
      for await (const { chunk, meta } of inputs) {
        hash.update(chunk);
        sizes.push(chunk.byteLength);
        metas.push(meta);
      }
      return { sizes, sha256: hash.digest('hex'), metas };
    },
    'files.ingest': async ({ file }) => {
      const hash = createHash('sha256');
      for await (const chunk of file.stream()) hash.update(chunk);
      return { size: file.size, sha256: hash.digest('hex') };
    },
    'export.get': () => ({ archive: download.fromBytes(EXPORT, { type: 'application/x-test' }) }),
    'export.big': () => {
      const source = download.fromBytes(BIG, { type: 'application/x-big' });
      s.armed = true; // the proxy cuts the connection once a MiB of the download went through
      return {
        archive: {
          ...source,
          open(range) {
            s.ranges.push(range);
            return source.open(range);
          },
        } satisfies DownloadSource,
      };
    },
    'export.bad': () => ({ archive: { ...download.fromBytes(new Uint8Array(1000)), sha256: '0'.repeat(64) } }),
    'slow.get': async () => {
      await sleep(500);
      return 'late';
    },
    'flaky.get': () => {
      if (++s.flaky === 1) throw new ApueError(503, 'Service Unavailable', 'warming up', { retryable: true }, { 'retry-after': '1' });
      return 'warm';
    },
    'class': () => ({ 'odd-key': null }),
  };
}

/** A TCP proxy in front of the server: counts connections; when armed, cuts one after 1 MiB. */
async function cuttingProxy(target: string, s: ReturnType<typeof state>) {
  const { port: targetPort } = new URL(target);
  const sockets = new Set<net.Socket>();
  const stats = { connections: 0, cuts: 0 };
  const server = net.createServer((client) => {
    stats.connections++;
    const upstream = net.connect(Number(targetPort), '127.0.0.1');
    sockets.add(client).add(upstream);
    let sinceArmed = 0;
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => {
      if (s.armed) {
        sinceArmed += chunk.byteLength;
        if (sinceArmed > 1024 * 1024) {
          s.armed = false;
          stats.cuts++;
          client.destroy();
          upstream.destroy();
          return;
        }
      }
      client.write(chunk);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    stats,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const RUN = String.raw`
import com.example.api.Api.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

public class Run {
  interface Body {
    Object get() throws Exception;
  }

  static final Map<String, Object> out = new TreeMap<>();

  static void run(String name, Body body) {
    Map<String, Object> result = new LinkedHashMap<>();
    try {
      result.put("ok", body.get());
    } catch (ApueException e) {
      result.put("error", (long) e.status());
      result.put("type", e.type());
      result.put("title", e.title());
      result.put("detail", e.detail());
      result.put("retryable", e.retryable());
    } catch (Exception e) {
      result.put("exception", e.toString());
    }
    out.put(name, result);
  }

  static String sha(byte[] data) throws Exception {
    StringBuilder hex = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) hex.append(String.format("%02x", b));
    return hex.toString();
  }

  public static void main(String[] args) throws Exception {
    String base = args[0];
    Options options = new Options().trustedCertificates(Path.of(args[1])).authorization("Bearer java").backoff(Duration.ofMillis(10));
    try (Client c = new Client(base, options)) {
      run("get", () -> c.usersGet(new UsersGetInput("ab")).toJson());
      run("get_typed", () -> {
        UsersGetOutput o = c.usersGet(new UsersGetInput("ab"));
        return List.of(o.role() == UsersGetOutputRole.MEMBER, o.role().json(), o.nick() != null && o.nick().isEmpty(), o.tags());
      });
      run("get_long", () -> (long) c.usersGet(new UsersGetInput("x".repeat(3000))).id().length());
      run("void", () -> c.usersNone());
      run("keyword", () -> {
        ClassOutput o = c.class_();
        return Arrays.asList(o.oddKey(), o.toJson());
      });
      run("create", () -> {
        CallOptions keyed = new CallOptions().idempotencyKey("k-java");
        // Without the optional note: it must be left out, not sent as null (the server would answer 400).
        return List.of(c.ordersCreate(new OrdersCreateInput("x"), keyed), c.ordersCreate(new OrdersCreateInput("x", null), keyed), c.ordersCreate(new OrdersCreateInput("y", "gift")));
      });
      run("problem", () -> {
        c.ordersFail();
        return null;
      });
      run("validation", () -> c.usersGet(new UsersGetInput("a")).toJson());
      run("stream", () -> c.countUp(new CountUpInput(5)).toList());
      List<Object> seen = new ArrayList<>();
      run("stream_error", () -> {
        for (double x : c.countFail()) seen.add(x);
        return null;
      });
      out.put("stream_error_seen", seen);
      run("stream_close", () -> {
        List<Object> first;
        try (Stream<Double> s = c.countUp(new CountUpInput(1000000))) {
          first = List.of(s.next(), s.next(), s.next());
        }
        // While this JVM (and its connection) lives on: the server saw the stream's reset.
        boolean cancelled = false;
        for (int i = 0; i < 100 && !cancelled; i++) {
          cancelled = c.countCancelled();
          if (!cancelled) Thread.sleep(10);
        }
        return List.of(first, cancelled);
      });
      run("client_stream", () -> c.sumClient(List.of(1.0, 2.0, 3.0, 4.0)));
      run("client_stream_failure", () -> c.sumClient(() -> new Iterator<Double>() {
        int taken;

        public boolean hasNext() {
          return true;
        }

        public Double next() {
          if (taken++ < 2) return 1.0;
          throw new IllegalStateException("inputs failed");
        }
      }));
      run("bidi", () -> c.echoBidi(List.of(new EchoBidiInput(1), new EchoBidiInput(2))).stream().map(EchoBidiOutput::toJson).toList());
      byte[] big = new byte[1024 * 1024 + 12];
      for (int i = 0; i < 1024 * 1024; i++) big[i] = (byte) i;
      System.arraycopy("{\"$blob\": 1}".getBytes(StandardCharsets.UTF_8), 0, big, 1024 * 1024, 12);
      run("bytes", () -> {
        FilesEchoOutput r = c.filesEcho(new FilesEchoInput(big, Map.of("$blob", 0)));
        return List.of(r.size(), sha(r.data()), sha(big), r.meta());
      });
      byte[] part = Arrays.copyOf(big, 200000);
      run("blob_stream", () -> c.blobsCollect(List.of(
          new BlobsCollectInput(part, Map.of("$lit", "x")),
          new BlobsCollectInput(new byte[0], List.of(Map.of("$blob", 1))),
          new BlobsCollectInput(new byte[] {1, 2, 3}, null))).toJson());
      run("file_bytes", () -> c.filesIngest(new FilesIngestInput(FileInput.of("hello file".getBytes(StandardCharsets.UTF_8)))).toJson());
      Path file = Path.of(args[2], "upload.bin");
      Files.write(file, "y".repeat(500000).getBytes(StandardCharsets.UTF_8));
      run("file_path", () -> c.filesIngest(new FilesIngestInput(FileInput.of(file))).toJson());
      run("file_stream", () -> c.filesIngest(new FilesIngestInput(FileInput.of(new ByteArrayInputStream("x".repeat(300000).getBytes(StandardCharsets.UTF_8))))).toJson());
      run("download", () -> {
        Download d = c.exportGet().archive();
        return List.of(d.url().toString().startsWith(base + "/$downloads/"), d.size(), d.type(), sha(d.readAllBytes()), d.sha256(), d.expires().isAfter(java.time.Instant.now()));
      });
      run("download_corrupt", () -> sha(c.exportBad().archive().readAllBytes()));
      run("deadline", () -> c.slowGet(new CallOptions().timeout(Duration.ofMillis(50))));
      run("retry", () -> {
        long start = System.nanoTime();
        String value = c.flakyGet();
        return List.of(value, (System.nanoTime() - start) / 1000000);
      });
      run("resume", () -> {
        Download d = c.exportBig().archive();
        return List.of(d.size(), sha(d.readAllBytes()), d.sha256());
      });
      run("after_errors", () -> c.usersGet(new UsersGetInput("zz")).id());
      run("canonical", () -> {
        List<String> written = new ArrayList<>();
        for (Object sample : Json.decodeList(Json.parse(Files.readString(Path.of(args[3]))), x -> x)) written.add(Json.write(sample));
        return written;
      });
    }
    System.out.println(Json.write(out));
  }
}
`;

/** Values whose canonical JSON Java must write exactly as src/api.ts does. */
function canonicalSamples(): unknown[] {
  let seed = 0x2545f491;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const doubles: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  while (doubles.length < 400) {
    view.setUint32(0, Math.floor(random() * 2 ** 32));
    view.setUint32(4, Math.floor(random() * 2 ** 32));
    const d = view.getFloat64(0);
    if (Number.isFinite(d)) doubles.push(d);
  }
  for (let e = -330; e <= 310; e += 7) doubles.push(1.2345678901234567 * 10 ** e, 2 ** (e / 3), 10 ** e);
  return [
    0, 1, -1, 0.1, 0.1 + 0.2, 1e21, 1e-7, 1e-6, 123456789012345680000, 5e-324, 1.7976931348623157e308, 2 ** 53, -1.5e-10, 100, 1e20, 4.35, 9.007199254740993e15,
    2 ** -1074 * 3, 2 ** 1023, 2 ** -1022,
    { b: 1, a: [true, false, null], é: 'x', '😀': 'emoji', '￿': 'last', z: '\u0000\u001f"\\\n /', '': { nested: [1.5, 'ü'] } },
    'lone \ud800 surrogate',
    ...doubles,
  ];
}

test('a generated Java client against a live server', { skip }, async (ctx) => {
  const s = state();
  // One upload at a time per client: an upload the client failed to delete after its call fails the next one (507).
  const server = await startServer(api, handlers(s), { uploads: { scopeUploads: 1 } });
  const proxy = await cuttingProxy(server.url, s);
  const dir = mkdtempSync(join(tmpdir(), 'apue-java-'));
  ctx.after(async () => {
    await proxy.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ca = join(dir, 'ca.pem');
  writeFileSync(ca, testCert().cert);
  const samples = JSON.parse(JSON.stringify(canonicalSamples())) as unknown[];
  writeFileSync(join(dir, 'samples.json'), JSON.stringify(samples));
  const sources = join(dir, 'src');
  mkdirSync(join(sources, 'com', 'example', 'api'), { recursive: true });
  writeFileSync(join(sources, 'Run.java'), RUN);
  // Through the CLI, like a user: manifest over HTTPS → Api.java in a package.
  const generated = join(sources, 'com', 'example', 'api', 'Api.java');
  await run(process.execPath, [join(ROOT, 'bin', 'apue-types.ts'), server.url, '--lang', 'java', '--package', 'com.example.api', '--ca', ca, '--out', generated]);
  await run('javac', ['-Xlint:all', '-Werror', '-d', join(dir, 'classes'), generated, join(sources, 'Run.java')], { timeout: 120_000 });
  const { stdout } = await run('java', ['-cp', join(dir, 'classes'), 'Run', proxy.url, ca, dir, join(dir, 'samples.json')], { timeout: 60_000 });
  const out = JSON.parse(stdout) as Record<string, { ok?: any; error?: number; type?: string; title?: string; detail?: string; exception?: string }>;

  assert.deepEqual(out.get, { ok: { id: 'ab', nick: null, role: 'member', tags: ['a'] } });
  assert.deepEqual(out.get_typed, { ok: [true, 'member', true, ['a']] }, 'enum, optional array, optional-nullable present as null');
  assert.deepEqual(out.get_long, { ok: 3000 });
  assert.deepEqual(
    s.users.map((u) => [u.id, u.method]),
    [['ab', 'GET'], ['ab', 'GET'], ['long:3000', 'POST'], ['zz', 'GET']], // 'a' fails validation before the handler
    'cacheable reads are GET ?i=, POST when the URL would be too long',
  );
  assert.ok(s.users.every((u) => u.version === '2.0' && u.auth === 'Bearer java'), 'HTTP/2, Authorization on every call');
  assert.deepEqual(out.void, { ok: 'none' });
  assert.deepEqual(out.keyword, { ok: [null, { 'odd-key': null }] });
  const [first, replay, other] = out.create!.ok as number[];
  assert.equal(replay, first, 'same Idempotency-Key: the stored result');
  assert.equal(other, first! + 1);
  assert.deepEqual(out.problem, { error: 409, type: 'https://example.com/problems/out-of-stock', title: 'Out Of Stock', detail: 'item gone', retryable: false });
  assert.equal(out.validation!.error, 400);
  assert.equal(out.validation!.type, 'https://apue.dev/problems/validation-failed');
  assert.deepEqual(out.stream, { ok: [1, 2, 3, 4, 5] });
  assert.deepEqual([out.stream_error!.error, out.stream_error!.detail, out.stream_error_seen], [409, 'midway', [1]]);
  assert.deepEqual(out.stream_close, { ok: [[1, 2, 3], true] }, 'closing a stream early resets it and aborts the handler');
  assert.deepEqual(out.client_stream, { ok: 10 });
  assert.deepEqual(out.client_stream_failure, { exception: 'java.lang.IllegalStateException: inputs failed' }, "the inputs' own exception");
  assert.deepEqual(out.bidi, { ok: [{ n: 2 }, { n: 4 }] });
  const [size, echoed, sent, meta] = out.bytes!.ok as [number, string, string, unknown];
  assert.equal(size, 1024 * 1024 + 12);
  assert.equal(echoed, sent, 'bytes through an upload in and BLOB frames out');
  assert.deepEqual(meta, { $blob: 0 }, 'a $blob look-alike in JSON survives ($lit escape on the wire)');
  const part = new Uint8Array(200000).map((_, i) => i & 0xff);
  assert.deepEqual(out.blob_stream, {
    ok: { metas: [{ $lit: 'x' }, [{ $blob: 1 }], null], sha256: sha(Buffer.concat([part, new Uint8Array([1, 2, 3])])), sizes: [200000, 0, 3] },
  }, 'BLOB frames from Java, look-alikes escaped');
  assert.deepEqual(out.file_bytes, { ok: { sha256: sha('hello file'), size: 10 } });
  assert.deepEqual(out.file_path, { ok: { sha256: sha('y'.repeat(500000)), size: 500000 } });
  assert.deepEqual(out.file_stream, { ok: { sha256: sha('x'.repeat(300000)), size: 300000 } });
  assert.deepEqual(out.download, { ok: [true, EXPORT.byteLength, 'application/x-test', sha(EXPORT), sha(EXPORT), true] });
  assert.deepEqual([out.download_corrupt!.error, out.download_corrupt!.detail], [502, 'download content does not match its SHA-256']);
  assert.equal(out.deadline!.error, 504);
  const [warm, waited] = out.retry!.ok as [string, number];
  assert.equal(warm, 'warm');
  assert.equal(s.flaky, 2, '503 retried once');
  assert.ok(waited >= 900, `Retry-After: 1 honoured (waited ${waited} ms)`);
  assert.deepEqual(out.resume, { ok: [BIG.byteLength, sha(BIG), sha(BIG)] });
  assert.equal(proxy.stats.cuts, 1, 'the download lost its connection once');
  assert.equal(s.ranges.length, 2, JSON.stringify(s.ranges));
  assert.equal(s.ranges[0]?.start ?? 0, 0);
  assert.ok(s.ranges[1]!.start > 512 * 1024 && s.ranges[1]!.end === BIG.byteLength - 1, `resumed with Range: ${JSON.stringify(s.ranges)}`);
  assert.deepEqual(out.after_errors, { ok: 'zz' });
  assert.equal(proxy.stats.connections, 2, 'one HTTP/2 connection through every error and early close; a second one only after the cut');
  assert.deepEqual(out.canonical, { ok: samples.map((sample) => canonicalJson(sample)) }, 'canonical JSON matches src/api.ts');
});

test('Java runtime template compiles on its own (javac -Xlint:all -Werror)', { skip }, async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'apue-java-rt-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  await run('javac', ['-Xlint:all', '-Werror', '-d', dir, join(ROOT, 'src', 'java', 'Runtime.java')], { timeout: 60_000 });
});

test('Java generation: awkward names compile, output is ASCII', { skip }, async (ctx) => {
  const awkward = defineApi({
    'class': op({ effect: 'safe', input: t.void(), output: t.string() }),
    'users.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
    'users_get': op({ effect: 'safe', input: t.void(), output: t.string() }),
    'upload': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
    'a-b.c': op({
      effect: 'idempotent',
      description: 'Tricky */ text \\u000a with <html> & @tags, ünïcödé and a\nsecond line',
      input: t.object({
        'odd-key': t.string(),
        'class': t.optional(t.number()),
        'hashCode': t.boolean(),
        '$blob': t.unknown(),
        'toJson': t.nullable(t.array(t.object({ x: t.optional(t.nullable(t.bytes())) }))),
        '': t.number({ int: true }),
        '1st': t.enum(['a-b', 'A_B', '', '1', 'ü', 'aB']),
        'oddKey': t.string(),
        'naïve': t.optional(t.string()),
      }),
      output: t.array(t.object({ '*/': t.string(), 'ü"\\': t.nullable(t.enum(['x'])) })),
    }),
    'up.load': op({ effect: 'unsafe', input: t.object({ f: t.file(), b: t.bytes() }), output: t.object({ d: t.download({ type: 'text/plain' }) }) }),
    'Api': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.nullable(t.number()) }),
    'Json.x': op({ effect: 'unsafe', stream: 'bidi', input: t.unknown(), output: t.void() }),
  });
  const code = generateJava(buildManifest(awkward) as unknown as Manifest, { source: 'test ü', className: 'Weird' });
  assert.match(code, /^[\x00-\x7f]*$/, 'pure ASCII');
  for (const name of ['class_', 'usersGet', 'usersGet2', 'upload_', 'aBC', 'api', 'jsonX']) assert.match(code, new RegExp(`public \\S+ ${name.replace('$', '\\$')}\\(`), name);
  assert.match(code, /public record ABCInput\(String oddKey, Double class_, boolean hashCode_, Object blob, List<ABCInputToJsonItem> toJson_, long value, ABCInput1st _1st, String oddKey2, String naVe\)/);
  const dir = mkdtempSync(join(tmpdir(), 'apue-java-names-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'Weird.java'), code);
  await run('javac', ['-Xlint:all', '-Werror', '-encoding', 'US-ASCII', '-d', join(dir, 'classes'), join(dir, 'Weird.java')], { timeout: 60_000 });
});

test('Java generation rejects what it cannot express', () => {
  const manifest = (schema: object): Manifest => ({ apue: 'test', ops: { 'x.y': { effect: 'safe', stream: 'none', input: { type: 'null' }, output: schema } } });
  assert.throws(() => generateJava(manifest({ anyOf: [{ type: 'string' }, { type: 'number' }] })), /unsupported JSON Schema/);
  assert.throws(() => generateJava(manifest({ type: 'string', format: 'email' })), /unsupported JSON Schema/);
  assert.throws(() => generateJava(manifest({ type: 'object', additionalProperties: { type: 'string' } })), /unsupported JSON Schema/);
  assert.throws(() => generateJava(manifest({ type: 'string' }), { className: 'Json' }), /invalid Java class name/);
  assert.throws(() => generateJava(manifest({ type: 'string' }), { packageName: 'com.class.x' }), /invalid Java package name/);
});

test('Java names: identifiers, keywords escaped', () => {
  assert.equal(javaMethodName('users.get'), 'usersGet');
  assert.equal(javaMethodName('class'), 'class_');
  assert.equal(javaMethodName('a-b.c'), 'aBC');
  assert.equal(javaMethodName('close'), 'close_');
  assert.equal(javaFieldName('odd-key'), 'oddKey');
  assert.equal(javaFieldName('hashCode'), 'hashCode_');
  assert.equal(javaFieldName('1st'), '_1st');
  assert.equal(javaString('a"\\\n \u0001'), '"a\\"\\\\\\n\\u2028\\001"');
});
