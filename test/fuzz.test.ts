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
