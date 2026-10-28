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
import { webSocketTransport } from '../src/transport-ws.ts';
import { drained } from '../src/node-streams.ts';
import { encodeWsFrame, parseCredit, WS_INITIAL_WINDOW, WsConnection, WsParser } from '../src/websocket.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  'echo.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.object({ echo: t.number() }) }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'slow.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.number() }),
  'plain.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'stall.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'flood': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.string() }),
  'echo.big': op({ effect: 'unsafe', stream: 'bidi', input: t.string(), output: t.string() }),
});
let aborted = 0;
let flooded = 0;
const ITEM = 'x'.repeat(64 * 1024);
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
  'stall.client': async (_inputs, ctx) => {
    // never reads its input: whatever the client sends stays queued
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return 0;
  },
  'flood': async function* (inputs) {
    for await (const _ of inputs) break;
    for (let i = 0; i < 4000; i++) {
      flooded++;
      yield ITEM;
    }
  },
  'echo.big': async function* (inputs) {
    for await (const s of inputs) yield s;
  },
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
    const ws = new WebSocket(`${local.url.replace('https', 'wss')}/slow.duplex`, 'apue.v1');
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
  const all = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'apue.v1', ...headers };
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
    assert.match(ws.head, /Sec-WebSocket-Protocol: apue\.v1/i);
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

  test('text messages are credit: invalid, overflowing or fragmented → 1002; unmasked frames → 1002', async () => {
    for (const payload of ['hello', '0', '-5', '0100', '2147483648', '']) {
      const ws = await rawWs('/sum.client');
      ws.send(0x1, Buffer.from(payload));
      assert.equal(await closeCodeFor(ws), 1002, `credit ${JSON.stringify(payload)}`);
    }
    const overflow = await rawWs('/sum.client'); // 64 KiB initial + 2^31-1 > 2^31-1
    overflow.send(0x1, Buffer.from('2147483647'));
    assert.equal(await closeCodeFor(overflow), 1002);
    const fragmented = await rawWs('/sum.client');
    fragmented.send(0x1, Buffer.from('100'), { fin: false });
    fragmented.send(0x0, Buffer.from('0'));
    assert.equal(await closeCodeFor(fragmented), 1002);
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
    assert.equal(await connect({ ':protocol': 'websocket', 'sec-websocket-version': '13', 'sec-websocket-protocol': 'apue.v1' }), 200);
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

describe('flow control (apue.v1 credit)', () => {
  test('parseCredit: decimal 1..2^31-1, nothing else', () => {
    assert.equal(parseCredit('1'), 1);
    assert.equal(parseCredit('65536'), 65536);
    assert.equal(parseCredit('2147483647'), 2 ** 31 - 1);
    for (const bad of ['', '0', '01', '+1', '-1', '1.5', '1e3', ' 1', '2147483648', '99999999999', '١']) assert.equal(parseCredit(bad), undefined, bad);
  });

  test('a stalled consumer bounds what the server produces (was: everything, 250 MiB)', async () => {
    const client = new ApueClient(api, webSocketTransport(server.url, { receiveWindow: 1024 * 1024 }));
    flooded = 0;
    async function* one() {
      yield 1;
      await sleep(3000);
    }
    const items = client.duplex('flood', one())[Symbol.asyncIterator]();
    await items.next();
    await sleep(500); // consumer stalls; the server must stop at the window
    const stalledAt = flooded;
    // 1 MiB client window + 256 KiB server frame buffer + one item in flight ≈ 22 items of 64 KiB
    assert.ok(stalledAt < 30, `server produced ${stalledAt} items while the consumer stalled`);
    await sleep(200);
    assert.equal(flooded, stalledAt, 'still producing');
    // consuming again resumes the flow, all items arrive
    let received = 1;
    for (;;) {
      const next = await items.next();
      if (next.done) break;
      assert.equal(next.value.length, ITEM.length);
      received++;
    }
    assert.equal(received, 4000);
    await client.close();
  });

  test('both directions saturated with a read-one-write-one handler: no deadlock', { timeout: 30_000 }, async () => {
    // Credit travels as text messages outside the windows and both sides read eagerly, so a
    // credit can never wait behind data the other side refuses to read.
    const client = new ApueClient(api, webSocketTransport(server.url, { receiveWindow: 128 * 1024 }));
    const big = 'y'.repeat(200 * 1024); // larger than either window: always split
    async function* inputs() {
      for (let i = 0; i < 100; i++) yield big;
    }
    let count = 0;
    for await (const echo of client.duplex('echo.big', inputs())) {
      assert.equal(echo.length, big.length);
      if (++count % 10 === 0) await sleep(5); // slow consumer
    }
    assert.equal(count, 100);
    await client.close();
  });

  test('the server sends no more than the client granted, and resumes on credit', async () => {
    const ws = await rawWs('/flood');
    ws.send(0x2, concatBytes([msgFrame(1)])); // start the flood; grant nothing beyond the initial window
    let received = 0;
    let granted = WS_INITIAL_WINDOW;
    const frames = ws.frames();
    let pending: ReturnType<typeof frames.next> | undefined; // survives a timeout: no frame is lost
    const take = async (until: number, ms: number) => {
      const deadline = Date.now() + ms;
      while (received < until && Date.now() < deadline) {
        pending ??= frames.next();
        const next = await Promise.race([pending, sleep(deadline - Date.now()).then(() => undefined)]);
        if (!next) break;
        pending = undefined;
        if (next.done) break;
        if (next.value.opcode === 0x2 || next.value.opcode === 0x0) received += next.value.payload.byteLength;
      }
    };
    await take(granted + 1, 300);
    assert.equal(received, granted); // exactly the initial window, split to fit
    ws.send(0x1, Buffer.from(String(100_000)));
    granted += 100_000;
    await take(granted + 1, 300);
    assert.equal(received, granted);
    ws.socket.destroy();
  });

  test('a client sending beyond its window is closed with 1008; exactly the window is fine', async () => {
    // The server grants 1 MiB right after the handshake (64 KiB initial + increment).
    const exact = await rawWs('/stall.client');
    const frames = exact.frames();
    const first = await frames.next();
    assert.equal(first.value!.opcode, 0x1);
    const window = WS_INITIAL_WINDOW + parseCredit(Buffer.from(first.value!.payload).toString())!;
    assert.equal(window, 1024 * 1024);
    exact.send(0x2, new Uint8Array(window));
    const closed = await Promise.race([frames.next().then(() => 'frame'), sleep(300).then(() => 'quiet')]);
    assert.equal(closed, 'quiet');
    exact.socket.destroy();

    const over = await rawWs('/stall.client');
    over.send(0x2, new Uint8Array(window));
    over.send(0x2, new Uint8Array(1));
    assert.equal(await closeCodeForFrames(over.frames()), 1008);
  });
});

test('webSocketWindow sets the window the server grants (over RFC 8441 too)', async () => {
  const local = await startServer(api, handlers, { webSocketWindow: 256 * 1024 });
  const ws = new WebSocket(`${local.url.replace('https', 'wss')}/stall.client`, 'apue.v1');
  const credit = await new Promise<string>((resolve) => (ws.onmessage = (e) => resolve(String(e.data))));
  assert.equal(WS_INITIAL_WINDOW + parseCredit(credit)!, 256 * 1024);
  ws.close();
  await local.close();
});

async function closeCodeForFrames(frames: AsyncGenerator<{ opcode: number; payload: Uint8Array }>): Promise<number> {
  for await (const frame of frames) if (frame.opcode === 0x8) return Buffer.from(frame.payload).readUInt16BE(0);
  return 0;
}

void decodeFrames;
