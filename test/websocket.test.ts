// Tier T3: apü calls over WebSocket (RFC 8441 over HTTP/2 and RFC 6455 Upgrade over HTTP/1.1).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { Duplex } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import tls from 'node:tls';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { decodeFrames, decodeJson, endFrame, FrameDecoder, FrameType, msgFrame, concatBytes } from '../src/frame.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { MAX_BUFFERED, pump, webSocketTransport } from '../src/transport-ws.ts';
import { drained } from '../src/node-streams.ts';
import { encodeWsFrame, WsConnection, WsParser } from '../src/websocket.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  'echo.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.object({ echo: t.number() }) }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'slow.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.number() }),
  'plain.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
});
let aborted = 0;
const handlers: Handlers<typeof api> = {
  'echo.duplex': async function* (inputs) {
    for await (const value of inputs) yield { echo: value };
  },
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'slow.duplex': async function* (_inputs, ctx) {
    ctx.signal.addEventListener('abort', () => aborted++);
    for (let i = 0; ; i++) {
      yield i;
      await sleep(20);
    }
  },
  'plain.get': () => 'plain',
};

let server: { url: string; close(): Promise<void> };
before(async () => {
  server = await startServer(api, handlers);
});
after(() => server.close());

async function* numbers(n: number) {
  for (let i = 1; i <= n; i++) yield i;
}

describe('apü over WebSocket (Node client: HTTP/2 extended CONNECT)', () => {
  test('full duplex: each echo arrives before the next input is sent', async () => {
    const client = new ApueClient(api, webSocketTransport(server.url));
    let lastEcho = 0;
    async function* inputs() {
      for (let i = 1; i <= 5; i++) {
        yield i;
        while (lastEcho < i) await sleep(1);
      }
    }
    const out: number[] = [];
    for await (const { echo } of client.duplex('echo.duplex', inputs())) {
      lastEcho = echo;
      out.push(echo);
    }
    assert.deepEqual(out, [1, 2, 3, 4, 5]);
  });

  test('client streaming: unary result delivered in-band', async () => {
    const client = new ApueClient(api, webSocketTransport(server.url));
    assert.deepEqual(await Array.fromAsync(client.duplex('sum.client', numbers(1000))), [500500]);
  });

  test('errors arrive in-band: invalid input message → 400, unknown op → 404, unary op → 415', async () => {
    const client = new ApueClient(api, webSocketTransport(server.url));
    async function* bad() {
      yield 1;
      yield 'x' as unknown as number;
    }
    const loose = new ApueClient(
      { 'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.unknown(), output: t.unknown() }), 'nope.x': op({ effect: 'unsafe', stream: 'bidi', input: t.unknown(), output: t.unknown() }), 'plain.get': op({ effect: 'unsafe', stream: 'client', input: t.unknown(), output: t.unknown() }) },
      webSocketTransport(server.url),
    );
    await assert.rejects(Array.fromAsync(loose.duplex('sum.client', bad())), (e: ApueError) => e.status === 400);
    await assert.rejects(Array.fromAsync(loose.duplex('nope.x', numbers(1))), (e: ApueError) => e.status === 404);
    await assert.rejects(Array.fromAsync(loose.duplex('plain.get', numbers(1))), (e: ApueError) => e.status === 415);
    void client;
  });

  test('deadline via ?timeout → in-band 504', async () => {
    const client = new ApueClient(api, webSocketTransport(server.url));
    async function* never() {
      await new Promise(() => {});
      yield 0;
    }
    const seen: number[] = [];
    await assert.rejects(
      async () => {
        for await (const n of client.duplex('slow.duplex', never(), { timeoutMs: 150 })) seen.push(n);
      },
      (e: ApueError) => e.status === 504,
    );
    assert.ok(seen.length >= 1);
  });

  test('breaking out of the loop closes the WebSocket and aborts the handler', async () => {
    const before = aborted;
    const client = new ApueClient(api, webSocketTransport(server.url));
    async function* idle() {
      await new Promise(() => {});
      yield 0;
    }
    for await (const n of client.duplex('slow.duplex', idle())) if (n === 2) break;
    for (let i = 0; i < 50 && aborted === before; i++) await sleep(10);
    assert.equal(aborted, before + 1);
  });

  test('server.close() ends open WebSockets with 1001', async () => {
    const local = await startServer(api, handlers);
    const ws = new WebSocket(`${local.url.replace('https', 'wss')}/slow.duplex`, 'apue.v0');
    await new Promise((resolve) => (ws.onopen = resolve));
    const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
    await local.close();
    assert.equal(await closed, 1001);
  });
});

// ---------------------------------------------------------------------------------------------
// Protocol level over HTTP/1.1 (raw TLS socket, ALPN http/1.1).

interface RawWs {
  status: number;
  head: string;
  send(opcode: number, payload: Uint8Array, options?: { mask?: boolean; fin?: boolean }): void;
  frames(): AsyncGenerator<{ opcode: number; payload: Uint8Array }>;
  socket: tls.TLSSocket;
}

async function rawWs(path: string, headers: Record<string, string> = {}): Promise<RawWs> {
  const { port } = new URL(server.url);
  const socket = tls.connect({ host: '127.0.0.1', port: Number(port), ca: testCert().cert, ALPNProtocols: ['http/1.1'] });
  await new Promise((resolve) => socket.once('secureConnect', resolve));
  const key = randomBytes(16).toString('base64');
  const all = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'apue.v0', ...headers };
  socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(all).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
  let buffered = Buffer.alloc(0);
  const pending: Buffer[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  socket.on('data', (d: Buffer) => (pending.push(d), wake?.()));
  socket.on('close', () => ((ended = true), wake?.()));
  const next = async () => {
    while (pending.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
    return pending.shift();
  };
  while (!buffered.includes('\r\n\r\n')) {
    const chunk = await next();
    if (!chunk) break;
    buffered = Buffer.concat([buffered, chunk]);
  }
  const split = buffered.indexOf('\r\n\r\n');
  const head = buffered.subarray(0, split).toString();
  const rest = buffered.subarray(split + 4);
  const status = Number(head.split(' ')[1]);
  if (status === 101) {
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${accept.replace(/[+/]/g, '\\$&')}`, 'i'));
  }
  return {
    status,
    head,
    socket,
    send(opcode, payload, { mask = true, fin = true } = {}) {
      const frame = Buffer.from(encodeWsFrame(opcode, payload));
      if (!fin) frame[0] = frame[0]! & 0x7f;
      if (!mask) return void socket.write(frame);
      // Re-encode masked: header with mask bit + key, then masked payload.
      const headerLength = frame.byteLength - payload.byteLength;
      const header = Buffer.from(frame.subarray(0, headerLength));
      header[1] = header[1]! | 0x80;
      const maskKey = randomBytes(4);
      const masked = Buffer.from(payload).map((b, i) => b ^ maskKey[i & 3]!);
      socket.write(Buffer.concat([header, maskKey, masked]));
    },
    async *frames() {
      // Server frames are unmasked; parse minimally.
      let buf = rest;
      for (;;) {
        while (buf.byteLength >= 2) {
          let length = buf[1]! & 0x7f;
          let offset = 2;
          if (length === 126) ((length = buf.readUInt16BE(2)), (offset = 4));
          else if (length === 127) ((length = Number(buf.readBigUInt64BE(2))), (offset = 10));
          if (buf.byteLength < offset + length) break;
          yield { opcode: buf[0]! & 0x0f, payload: buf.subarray(offset, offset + length) };
          buf = buf.subarray(offset + length);
        }
        const chunk = await next();
        if (!chunk) return;
        buf = Buffer.concat([buf, chunk]);
      }
    },
  };
}

describe('WebSocket protocol details (HTTP/1.1 Upgrade)', () => {
  test('handshake, apü frames in fragmented binary messages, ping/pong, clean close', async () => {
    const ws = await rawWs('/sum.client');
    assert.equal(ws.status, 101);
    assert.match(ws.head, /Sec-WebSocket-Protocol: apue\.v0/i);
    const bytes = concatBytes([msgFrame(2), msgFrame(40), endFrame({ status: 200 })]);
    ws.send(0x9, Buffer.from('ping!'));
    ws.send(0x2, bytes.subarray(0, 5), { fin: false }); // fragmented: binary + continuation
    ws.send(0x0, bytes.subarray(5));
    const decoder = new FrameDecoder();
    const apue: Array<[number, unknown]> = [];
    let pong = '';
    let closeCode = 0;
    for await (const frame of ws.frames()) {
      if (frame.opcode === 0xa) pong = Buffer.from(frame.payload).toString();
      if (frame.opcode === 0x2) for (const f of decoder.push(frame.payload)) apue.push([f.type, decodeJson(f.payload)]);
      if (frame.opcode === 0x8) {
        closeCode = Buffer.from(frame.payload).readUInt16BE(0);
        ws.send(0x8, frame.payload);
      }
    }
    assert.equal(pong, 'ping!');
    assert.deepEqual(apue, [[FrameType.MSG, 42], [FrameType.END, { status: 200 }]]);
    assert.equal(closeCode, 1000);
  });

  const closeCodeFor = async (ws: RawWs) => {
    for await (const frame of ws.frames()) if (frame.opcode === 0x8) return Buffer.from(frame.payload).readUInt16BE(0);
    return 0;
  };

  test('text frames → close 1003; unmasked client frames → close 1002', async () => {
    const text = await rawWs('/sum.client');
    text.send(0x1, Buffer.from('hello'));
    assert.equal(await closeCodeFor(text), 1003);
    const unmasked = await rawWs('/sum.client');
    unmasked.send(0x2, msgFrame(1), { mask: false });
    assert.equal(await closeCodeFor(unmasked), 1002);
  });

  test('failed handshakes: version 426, missing subprotocol 400, foreign origin 403', async () => {
    assert.equal((await rawWs('/sum.client', { 'Sec-WebSocket-Version': '8' })).status, 426);
    assert.equal((await rawWs('/sum.client', { 'Sec-WebSocket-Protocol': 'chat' })).status, 400);
    assert.equal((await rawWs('/sum.client', { Origin: 'https://evil.example' })).status, 403);
    const { port } = new URL(server.url);
    assert.equal((await rawWs('/sum.client', { Origin: `https://127.0.0.1:${port}` })).status, 101);
  });
});

describe('WebSocket over HTTP/2 (extended CONNECT), negative cases', () => {
  const connect = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const session = http2.connect(server.url, { ca: testCert().cert });
      session.once('remoteSettings', () => {
        const req = session.request({ ':method': 'CONNECT', ':scheme': 'https', ':path': '/sum.client', ...headers });
        req.on('response', (h) => {
          resolve(Number(h[':status']));
          session.destroy();
        });
        req.on('error', reject);
      });
    });

  test('server advertises SETTINGS_ENABLE_CONNECT_PROTOCOL; checks subprotocol; other CONNECTs → 405', async () => {
    assert.equal(await connect({ ':protocol': 'websocket', 'sec-websocket-version': '13', 'sec-websocket-protocol': 'apue.v0' }), 200);
    assert.equal(await connect({ ':protocol': 'websocket', 'sec-websocket-version': '13' }), 400);
    assert.equal(await connect({ ':protocol': 'something-else' }), 405);
  });
});

describe('WsParser', () => {
  /** A client frame: masked with a random key (RFC 6455 §5.3). */
  function masked(opcode: number, payload: Uint8Array, fin = true): Buffer {
    const plain = encodeWsFrame(opcode, payload);
    const header = plain.byteLength - payload.byteLength;
    const key = randomBytes(4);
    const out = Buffer.alloc(plain.byteLength + 4);
    plain.copy(out, 0, 0, header);
    out[0] = (fin ? 0x80 : 0) | opcode;
    out[1]! |= 0x80;
    key.copy(out, header);
    for (let i = 0; i < payload.byteLength; i++) out[header + 4 + i] = payload[i]! ^ key[i & 3]!;
    return out;
  }
  const sizes = [0, 1, 125, 126, 127, 128, 129, 130, 131, 300, 65535, 65536, 70_000]; // word unmasking from 128: every tail length
  const payloads = sizes.map((n) => new Uint8Array(randomBytes(n)));
  const wire = Buffer.concat([...payloads.map((p) => masked(0x2, p)), masked(0x9, new Uint8Array([7])), masked(0x1, payloads[2]!, false)]);
  const check = (frames: Array<{ fin: boolean; opcode: number; payload: Uint8Array }>) => {
    assert.equal(frames.length, sizes.length + 2);
    payloads.forEach((p, i) => assert.ok(Buffer.from(frames[i]!.payload).equals(Buffer.from(p)), `payload ${sizes[i]}`));
    assert.deepEqual([frames.at(-2)!.opcode, [...frames.at(-2)!.payload]], [0x9, [7]]);
    assert.deepEqual([frames.at(-1)!.opcode, frames.at(-1)!.fin], [0x1, false]);
  };

  test('every split point of the header and payload boundaries yields the same frames', () => {
    // all 2-chunk splits within the first 400 bytes and around the 7- and 10-byte-length headers
    const boundaries = new Set<number>();
    for (let i = 1; i < 400; i++) boundaries.add(i);
    let at = 0;
    for (const p of payloads) {
      for (let d = -12; d <= 12; d++) if (at + d > 0 && at + d < wire.byteLength) boundaries.add(at + d);
      at += masked(0x2, p).byteLength;
    }
    for (const split of boundaries) {
      const parser = new WsParser(1 << 20);
      check([...parser.push(wire.subarray(0, split)), ...parser.push(wire.subarray(split))]);
    }
  });

  test('random chunking and one-byte chunks', () => {
    for (let round = 0; round < 50; round++) {
      const parser = new WsParser(1 << 20);
      const frames = [];
      for (let i = 0; i < wire.byteLength; ) {
        const n = round === 0 ? 1 : 1 + Math.floor(Math.random() * 5000);
        frames.push(...parser.push(wire.subarray(i, i + n)));
        i += n;
      }
      check(frames);
    }
  });

  test('a 16 MiB frame in 1 KiB chunks is linear, not quadratic (review finding)', () => {
    // Joining on every chunk copied ~128 GiB here (minutes); buffering until complete copies once.
    const big = new Uint8Array(16 << 20).fill(5);
    const frame = masked(0x2, big);
    const parser = new WsParser(32 << 20);
    const start = performance.now();
    const frames = [];
    for (let i = 0; i < frame.byteLength; i += 1024) frames.push(...parser.push(frame.subarray(i, i + 1024)));
    const ms = performance.now() - start;
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.payload.byteLength, big.byteLength);
    assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
  });

  test('a transport that closes while a write waits for drain releases the producer (review finding)', async () => {
    const io = new Duplex({ read() {}, write() {}, writableHighWaterMark: 1 }); // never drains
    const conn = new WsConnection(io);
    assert.equal(conn.sink.write(new Uint8Array(conn.sink.writableHighWaterMark + 1)), false); // above the sink's high-water mark
    conn.sink.write(new Uint8Array(100)); // queued behind the stuck one
    const released = drained(conn.sink);
    io.destroy();
    await Promise.race([released, sleep(1000).then(() => assert.fail('producer still waiting for drain'))]);
    assert.equal(conn.sink.destroyed, true);
  });

  test('protocol errors are detected from the header alone, before the payload arrives', () => {
    const unmasked = encodeWsFrame(0x2, new Uint8Array(10));
    assert.throws(() => new WsParser(1024).push(unmasked.subarray(0, 2)), /must be masked/);
    const tooBig = masked(0x2, new Uint8Array(2000));
    assert.throws(() => new WsParser(1024).push(tooBig.subarray(0, 4)), /too large/);
    const reserved = Buffer.from([0xc2, 0x80]);
    assert.throws(() => new WsParser(1024).push(reserved), /reserved bits/);
  });
});

describe('upload pacing (WebSocket has no drain event)', () => {
  /** A socket whose send buffer drains at `bytesPerMs`; counts how often bufferedAmount is read. */
  function fakeSocket(bytesPerMs: number) {
    let buffered = 0;
    let last = performance.now();
    const drain = () => {
      const now = performance.now();
      buffered = Math.max(0, buffered - (now - last) * bytesPerMs);
      last = now;
    };
    const socket = {
      OPEN: 1 as const,
      readyState: 1,
      polls: 0,
      maxBuffered: 0,
      get bufferedAmount() {
        drain();
        socket.polls++;
        return buffered;
      },
      send(chunk: Uint8Array) {
        drain();
        buffered += chunk.byteLength;
        socket.maxBuffered = Math.max(socket.maxBuffered, buffered);
      },
      close() {},
    };
    return socket;
  }
  async function* chunks(count: number, size: number) {
    for (let i = 0; i < count; i++) yield new Uint8Array(size);
  }

  test('memory stays bounded and a fast link stays busy', async () => {
    const socket = fakeSocket(1024 * 1024); // 1 GiB/s
    const start = performance.now();
    await pump(socket as unknown as WebSocket, chunks(256, 64 * 1024)); // 16 MiB
    const ms = performance.now() - start;
    assert.ok(socket.maxBuffered <= MAX_BUFFERED + 64 * 1024, `buffered up to ${socket.maxBuffered}`);
    // 16 ms of pure drain time; the old fixed 5 ms poll needed ≥ 80 ms (1 MiB per poll)
    assert.ok(ms < 60, `${ms.toFixed(0)} ms for 16 MiB at 1 GiB/s`);
  });

  test('a slow link is polled rarely (the interval backs off)', async () => {
    const socket = fakeSocket(10 * 1024); // 10 MiB/s
    await pump(socket as unknown as WebSocket, chunks(48, 64 * 1024)); // 3 MiB, ≥ 200 ms
    assert.ok(socket.maxBuffered <= MAX_BUFFERED + 64 * 1024);
    // ~one wake-up (two reads) per chunk once the buffer is full; a fixed 1 ms poll: ~400 reads
    assert.ok(socket.polls < 120, `${socket.polls} polls`);
  });

  test('a socket closing mid-upload ends the pump', async () => {
    const socket = fakeSocket(0); // never drains
    const done = pump(socket as unknown as WebSocket, chunks(1000, 64 * 1024));
    await sleep(20);
    socket.readyState = 3;
    await Promise.race([done, sleep(500).then(() => assert.fail('pump still running'))]);
  });
});

void decodeFrames;
