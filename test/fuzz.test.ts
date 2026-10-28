// Seeded fuzzing: the frame decoder and the server must reject garbage cleanly (FrameError / 4xx),
// never crash, hang or answer 5xx. Seeds are fixed so failures are reproducible.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { concatBytes, encodeFrame, FrameDecoder, FrameError, type Frame } from '../src/frame.ts';
import { MediaType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { Duplex } from 'node:stream';
import { ApueError } from '../src/protocol.ts';
import { WsConnection } from '../src/websocket.ts';
import { startServer, testCert } from './helpers.ts';

/** Mulberry32: small, fast, seedable PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    bytes(n: number) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
      return out;
    },
  };
}

function randomJson(r: ReturnType<typeof prng>, depth = 0): unknown {
  const kind = r.int(depth > 3 ? 5 : 8);
  switch (kind) {
    case 0: return null;
    case 1: return r.next() < 0.5;
    case 2: return (r.next() - 0.5) * 10 ** r.int(20);
    case 3: return String.fromCharCode(...Array.from({ length: r.int(12) }, () => r.int(0x2fff)));
    case 4: return r.int(1000);
    case 5: return Array.from({ length: r.int(5) }, () => randomJson(r, depth + 1));
    case 6: return Object.fromEntries(Array.from({ length: r.int(5) }, () => [['id', 'n', 'a', '$ref', '$lit', '__proto__', 'x'][r.int(7)]!, randomJson(r, depth + 1)]));
    default: return { id: randomJson(r, depth + 1) };
  }
}

describe('frame decoder fuzzing', () => {
  test('random bytes in random chunks: only FrameError, never anything else', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = prng(seed);
      const decoder = new FrameDecoder(1024);
      const bytes = r.bytes(r.int(4096));
      try {
        for (let offset = 0; offset < bytes.length; ) {
          const size = 1 + r.int(64);
          decoder.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
        decoder.end();
      } catch (error) {
        assert.ok(error instanceof FrameError, `seed ${seed}: ${String(error)}`);
      }
    }
  });

  test('random valid frames survive any chunking unchanged', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = prng(seed);
      const frames: Frame[] = Array.from({ length: 1 + r.int(30) }, () => ({ type: r.int(6), flags: r.int(4), lane: r.int(0x10000), payload: r.bytes(r.int(300)) }));
      const wire = concatBytes(frames.map((f) => encodeFrame(f.type, f.payload, f.lane, f.flags)));
      const decoder = new FrameDecoder();
      const got: Frame[] = [];
      for (let offset = 0; offset < wire.length; ) {
        const size = 1 + r.int(200);
        got.push(...decoder.push(wire.subarray(offset, offset + size)));
        offset += size;
      }
      decoder.end();
      const plain = (list: Frame[]) => list.map((f) => [f.type, f.flags, f.lane, Array.from(f.payload)]);
      assert.deepEqual(plain(got), plain(frames), `seed ${seed}`);
    }
  });
});

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string({ max: 64 }) }), output: t.object({ id: t.string() }) }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ items: t.array(t.object({ sku: t.string(), qty: t.number({ int: true, min: 1 }) }), { max: 10 }) }), output: t.number() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
});
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id }),
  'orders.create': ({ items }) => items.length,
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
};

let server: { url: string; close(): Promise<void> };
let session: http2.ClientHttp2Session;
before(async () => {
  server = await startServer(api, handlers, { maxBodyBytes: 64 * 1024 });
  session = http2.connect(server.url, { ca: testCert().cert });
});
after(async () => {
  session.close();
  await server.close();
});

function send(headers: Record<string, string>, body?: Uint8Array | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = session.request(headers);
    let status = 0;
    req.on('response', (h) => (status = Number(h[':status'])));
    req.on('data', () => {});
    req.on('end', () => resolve(status));
    req.on('error', reject);
    req.end(body);
  });
}

describe('server fuzzing', () => {
  test('random JSON inputs → 2xx or 4xx, never 5xx', async () => {
    const r = prng(42);
    const statuses = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const body = JSON.stringify({ calls: undefined, ...(r.next() < 0.5 ? (randomJson(r) as object) : { items: randomJson(r) }) });
      const path = ['/orders.create', '/users.get', '/$batch'][r.int(3)]!;
      const status = await send({ ':method': 'POST', ':path': path, 'content-type': MediaType.JSON }, body);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      assert.ok(status < 500, `5xx for ${path} ${body.slice(0, 200)}`);
    }
    assert.ok((statuses.get(400) ?? 0) > 0);
  });

  test('random GET query strings → 2xx or 4xx', async () => {
    const r = prng(7);
    for (let i = 0; i < 200; i++) {
      const raw = r.next() < 0.5 ? encodeURIComponent(JSON.stringify(randomJson(r))) : Array.from(r.bytes(r.int(40)), (b) => `%${b.toString(16).padStart(2, '0')}`).join('');
      const status = await send({ ':path': `/users.get?i=${raw}` });
      assert.ok(status < 500, `5xx for i=${raw}`);
    }
  });

  test('malformed paths and header values → 4xx, never 5xx', async () => {
    const id = encodeURIComponent('{"id":"1"}');
    const cases: Array<[Record<string, string>, number]> = [
      [{ ':path': '/users%E0%A4%A.get' }, 400], // invalid percent-encoding (was a 500)
      [{ ':path': `/users.get?i=${id}`, 'apue-timeout': '99999999999999999999' }, 400], // beyond timer range (was a 500)
      [{ ':path': `/users.get?i=${id}`, 'apue-timeout': '2147483648' }, 400],
      [{ ':path': `/users.get?i=${id}`, 'apue-timeout': '1.5' }, 400],
      [{ ':path': '/users.get?i=%E0%A4%A' }, 400],
      [{ ':path': '/../../etc/passwd' }, 404],
      [{ ':path': '/__proto__' }, 404],
      [{ ':path': '/constructor' }, 404],
      [{ ':path': '//users.get' }, 404],
      [{ ':path': '/' + 'a'.repeat(6000) }, 404],
      [{ ':path': `/users%2Eget?i=${id}` }, 200], // percent-encoded op names are the same op
    ];
    for (const [headers, expected] of cases) assert.equal(await send(headers), expected, JSON.stringify(headers).slice(0, 80));
  });

  test('deeply nested JSON → 400 before parsing, at every entry point (was a 500 from ~10,000 levels)', async () => {
    const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);
    const json = { ':method': 'POST', 'content-type': MediaType.JSON };
    for (const n of [65, 10_000, 400_000]) {
      // 400,000 levels are ~800 KB: the size limit (64 KiB here) answers first with 413.
      const expected = n * 2 > 64 * 1024 ? 413 : 400;
      assert.equal(await send({ ...json, ':path': '/orders.create', 'idempotency-key': `"deep-${n}"` }, `{"items":${deep(n)}}`), expected, `body depth ${n}`);
      assert.equal(await send({ ...json, ':path': '/$batch' }, `{"calls":[{"op":"users.get","in":{"id":${deep(n)}}}]}`), expected, `batch depth ${n}`);
    }
    assert.equal(await send({ ':path': `/users.get?i=${encodeURIComponent(`{"id":${deep(200)}}`)}` }), 400);
    const frame = (payload: string) => encodeFrame(0, new TextEncoder().encode(payload));
    assert.equal(await send({ ':method': 'POST', ':path': '/sum.client', 'content-type': MediaType.STREAM_JSON }, concatBytes([frame(deep(5_000))])), 400);
    // Strings full of brackets are not nesting; 64 levels are fine.
    assert.equal(await send({ ...json, ':path': '/users.get' }, JSON.stringify({ id: '[[[', pad: '['.repeat(500) })), 200);
    assert.equal(await send({ ...json, ':path': '/$batch' }, JSON.stringify({ calls: [{ op: 'users.get', in: { id: 'x', extra: JSON.parse(deep(60)) } }] })), 200);
  });

  test('garbage request streams → 4xx, server stays healthy', async () => {
    const r = prng(99);
    for (let i = 0; i < 100; i++) {
      const status = await send({ ':method': 'POST', ':path': '/sum.client', 'content-type': MediaType.STREAM_JSON }, r.bytes(r.int(2000)));
      assert.ok(status >= 200 && status < 500, `status ${status}`);
    }
    assert.equal(await send({ ':path': `/users.get?i=${encodeURIComponent('{"id":"ok"}')}` }), 200);
  });

  test('malformed stream messages: 400; oversized: 413', async () => {
    const msg = (payload: string) => encodeFrame(0, new TextEncoder().encode(payload));
    const end = encodeFrame(1, new TextEncoder().encode('{"status":200}'));
    assert.equal(await send({ ':method': 'POST', ':path': '/sum.client', 'content-type': MediaType.STREAM_JSON }, concatBytes([msg('{not json'), end])), 400);
    assert.equal(await send({ ':method': 'POST', ':path': '/sum.client', 'content-type': MediaType.STREAM_JSON }, concatBytes([msg('1'), encodeFrame(1, new TextEncoder().encode('{}'))])), 400);
    const huge = new Uint8Array(8);
    new DataView(huge.buffer).setUint32(4, 100 * 1024 * 1024);
    assert.equal(await send({ ':method': 'POST', ':path': '/sum.client', 'content-type': MediaType.STREAM_JSON }, huge), 413);
  });
});

describe('client against a garbage server', () => {
  test('malformed frames or JSON → ApueError 502, not a raw decoder error', async () => {
    const { ApueClient } = await import('../src/client.ts');
    const { ApueError } = await import('../src/protocol.ts');
    const streamApi = defineApi({ feed: op({ effect: 'safe', stream: 'server', input: t.void(), output: t.unknown() }), one: op({ effect: 'safe', input: t.void(), output: t.unknown() }) });
    const bodies: Record<string, [string, Uint8Array]> = {
      feed: [MediaType.STREAM_JSON, new Uint8Array([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])],
      one: [MediaType.JSON, new TextEncoder().encode('{broken')],
    };
    const transport = {
      async request(req: { path: string }) {
        const [type, bytes] = bodies[req.path.slice(1).split('?')[0]!]!;
        return { status: 200, headers: new Headers({ 'content-type': type }), body: (async function* () { yield bytes; })() };
      },
    };
    const client = new ApueClient(streamApi, transport);
    await assert.rejects(Array.fromAsync(client.stream('feed')), (e: InstanceType<typeof ApueError>) => e.status === 502 && e.problem.title === 'Malformed Stream');
    await assert.rejects(client.call('one'), (e: InstanceType<typeof ApueError>) => e.status === 502);
  });
});

describe('WebSocket connection fuzzing (parser, credit, fragmentation, close)', () => {
  /** A client frame: masked, any opcode, optionally fragmented, length encodings 7/16/64-bit. */
  function wsFrame(r: ReturnType<typeof prng>): Uint8Array {
    const opcodes = [0x0, 0x1, 0x2, 0x2, 0x2, 0x8, 0x9, 0xa, 0x3, 0xb];
    const opcode = opcodes[r.int(opcodes.length)]!;
    const payload =
      opcode === 0x1 && r.next() < 0.7
        ? new TextEncoder().encode(['65536', '1', '0', '-1', '2147483647', 'abc', '99999999999', ''][r.int(8)]!)
        : r.bytes([0, 1, 125, 126, 200, 70_000][r.int(6)]!);
    const fin = r.next() < 0.8 ? 0x80 : 0;
    const rsv = r.next() < 0.03 ? 0x40 : 0;
    const masked = r.next() < 0.97;
    const n = payload.byteLength;
    const header = n < 126 ? [n] : n < 65536 ? [126, n >> 8, n & 255] : [127, 0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const key = r.bytes(4);
    const body = masked ? payload.map((b, i) => b ^ key[i & 3]!) : payload;
    return concatBytes([new Uint8Array([fin | rsv | opcode, (masked ? 0x80 : 0) | header[0]!, ...header.slice(1)]), masked ? key : new Uint8Array(0), body]);
  }

  /** A well-formed session: binary messages (sometimes fragmented, pings in between), valid credit, maybe a close. */
  function validSession(r: ReturnType<typeof prng>): Uint8Array {
    const frame = (opcode: number, payload: Uint8Array, fin = true) => {
      const n = payload.byteLength;
      const header = n < 126 ? [n] : [126, n >> 8, n & 255];
      const key = r.bytes(4);
      return concatBytes([new Uint8Array([(fin ? 0x80 : 0) | opcode, 0x80 | header[0]!, ...header.slice(1)]), key, payload.map((b, i) => b ^ key[i & 3]!)]);
    };
    const parts: Uint8Array[] = [];
    for (let m = r.int(8); m > 0; m--) {
      const data = r.bytes([0, 1, 125, 126, 1000, 4000][r.int(6)]!);
      if (r.next() < 0.3 && data.byteLength > 2) {
        const cut = 1 + r.int(data.byteLength - 1);
        parts.push(frame(0x2, data.subarray(0, cut), false));
        if (r.next() < 0.5) parts.push(frame(0x9, r.bytes(r.int(20)))); // control frame inside a fragmented message
        parts.push(frame(0x0, data.subarray(cut)));
      } else {
        parts.push(frame(0x2, data));
      }
      if (r.next() < 0.3) parts.push(frame(0x1, new TextEncoder().encode(String(1 + r.int(100_000)))));
    }
    if (r.next() < 0.5) parts.push(frame(0x8, new Uint8Array([0x03, 0xe8])));
    return concatBytes(parts);
  }

  test('400 random sessions: no escaping exception or rejection, bounded writes, input ends cleanly or with ApueError', async (t) => {
    const escaped: unknown[] = [];
    const outcomes: Record<string, number> = {};
    const onEscape = (error: unknown) => escaped.push(error);
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);
    try {
      for (let seed = 1; seed <= 400; seed++) {
        const r = prng(seed);
        let written = 0;
        const io = new Duplex({
          read() {},
          write(chunk: Buffer, _encoding, callback) {
            written += chunk.byteLength;
            callback();
          },
        });
        const conn = new WsConnection(io, { window: 65_536 * (1 + r.int(4)), maxPayload: 1 << 20 });
        const input = (async () => {
          try {
            for await (const _ of conn) if (r.next() < 0.1) await new Promise((resolve) => setImmediate(resolve));
            return 'ended';
          } catch (error) {
            assert.ok(error instanceof ApueError, `seed ${seed}: ${error}`);
            return `error ${error.status}`;
          }
        })();
        const wire = seed % 2 === 0 ? validSession(r) : concatBytes(Array.from({ length: 1 + r.int(30) }, () => (r.next() < 0.05 ? r.bytes(r.int(20)) : wsFrame(r))));
        for (let offset = 0; offset < wire.length; ) {
          const size = 1 + r.int(4096);
          io.push(wire.subarray(offset, offset + size));
          offset += size;
        }
        if (r.next() < 0.5) conn.sink.write(r.bytes(r.int(200_000))); // server output racing the input
        await new Promise((resolve) => setImmediate(resolve));
        io.push(null);
        io.destroy();
        const outcome = await input;
        // well-formed sessions end cleanly or as "client gone" (no close frame) — never a protocol error
        if (seed % 2 === 0) assert.ok(outcome === 'ended' || outcome === 'error 499', `seed ${seed}: valid session → ${outcome}`);
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        assert.ok(written < 4 * 1024 * 1024, `seed ${seed}: wrote ${written} bytes`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      t.diagnostic(`outcomes: ${JSON.stringify(outcomes)}`);
      assert.ok((outcomes.ended ?? 0) > 20 && (outcomes['error 400'] ?? 0) > 20, 'the generator must reach both clean ends and protocol errors');
      assert.deepEqual(escaped, []);
    } finally {
      process.off('uncaughtException', onEscape);
      process.off('unhandledRejection', onEscape);
    }
  });
});
