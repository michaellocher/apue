// Tier T3: apü calls over WebSocket (RFC 8441 over HTTP/2 and RFC 6455 Upgrade over HTTP/1.1).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import http2 from 'node:http2';
import https from 'node:https';
import { Duplex } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import tls from 'node:tls';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { concatBytes, decodeFrames, decodeJson, endFrame, FrameDecoder, FrameType, msgFrame } from '../src/frame.ts';
import { drained } from '../src/node-streams.ts';
import { ApueError, checkWindow, parseCredit, WS_INITIAL_WINDOW } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { MAX_UNSENT, webSocketTransport } from '../src/transport-ws.ts';
import { encodeWsFrame, WsConnection, WsParser } from '../src/websocket.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  'echo.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.object({ echo: t.number() }) }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'slow.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.number() }),
  'plain.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'stall.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'flood': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.string() }),
  'echo.big': op({ effect: 'unsafe', stream: 'bidi', input: t.string(), output: t.string() }),
  'fails.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.number() }),
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
  'fails.duplex': async function* (inputs) {
    for await (const _ of inputs) throw new ApueError(409, 'Conflict', 'fails on purpose');
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

  test('closing: the client closes after END and the server answers at once; otherwise the server closes after ~2 s', async () => {
    for (const clientCloses of [true, false]) {
      const ws = await rawWs('/sum.client');
      ws.send(0x2, concatBytes([msgFrame(1), endFrame({ status: 200 })]));
      const decoder = new FrameDecoder();
      let endAt = 0;
      let closeAt = 0;
      let closeCode = 0;
      for await (const frame of ws.frames()) {
        if (frame.opcode === 0x2 && decoder.push(frame.payload).some((f) => f.type === FrameType.END)) {
          endAt = performance.now();
          if (clientCloses) ws.send(0x8, Buffer.from([0x0f, 0xa0])); // 4000, as the apü client does once it has the END
        }
        if (frame.opcode === 0x8) {
          closeAt = performance.now();
          closeCode = Buffer.from(frame.payload).readUInt16BE(0);
          if (!clientCloses) ws.send(0x8, frame.payload);
        }
      }
      // the server ended the transport after the handshake (frames() returned); it echoes the client's code
      assert.equal(closeCode, clientCloses ? 4000 : 1000);
      const waited = closeAt - endAt;
      if (clientCloses) assert.ok(waited < 500, `server answered the close after ${waited.toFixed(0)} ms`);
      else assert.ok(waited > 1900 && waited < 3000, `server closed after ${waited.toFixed(0)} ms`);
    }
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
    // The server grants its window right after the handshake (64 KiB initial + increment); the
    // default is streamWindow (4 MiB), the bound an HTTP/2 request stream gets.
    const exact = await rawWs('/stall.client');
    const frames = exact.frames();
    const first = await frames.next();
    assert.equal(first.value!.opcode, 0x1);
    const window = WS_INITIAL_WINDOW + parseCredit(Buffer.from(first.value!.payload).toString())!;
    assert.equal(window, 4 * 1024 * 1024);
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

test('webSocketTransport: calls without a request stream go over fetch (unary over WebSocket was a 415)', async () => {
  const client = new ApueClient(api, webSocketTransport(server.url));
  assert.equal(await client.call('plain.get'), 'plain');
  await assert.rejects(client.call('plain.get', 1 as unknown as undefined), (e: ApueError) => e.status === 400);
  assert.deepEqual(await Array.fromAsync(client.duplex('echo.duplex', numbers(2))), [{ echo: 1 }, { echo: 2 }]); // still T3
  assert.equal(await Array.fromAsync(client.duplex('sum.client', numbers(3))).then((r) => r[0]), 6);
  await client.close();
});

test('a stream message failing client-side validation is a 400 over WebSocket too (was a 502)', async () => {
  const client = new ApueClient(api, webSocketTransport(server.url));
  async function* bad() {
    yield 1;
    yield 'two' as unknown as number;
  }
  await assert.rejects(Array.fromAsync(client.duplex('echo.duplex', bad())), (e: ApueError) => e.status === 400 && /input message 1/.test(e.problem.detail ?? ''));
  await client.close();
});

test('the client closes with 1000 after END (also an error END) and with 4000 when it cancels', async () => {
  const codes: number[] = [];
  class Recording extends WebSocket {
    override close(code?: number, reason?: string) {
      codes.push(code ?? 1005);
      super.close(code, reason);
    }
  }
  const client = new ApueClient(api, webSocketTransport(server.url, { WebSocketImpl: Recording }));
  assert.equal((await Array.fromAsync(client.duplex('echo.duplex', numbers(3)))).length, 3);
  await assert.rejects(Array.fromAsync(client.duplex('fails.duplex', numbers(1))), (e: ApueError) => e.status === 409); // an error END
  for await (const _ of client.duplex('slow.duplex', numbers(1))) break; // cancel
  await sleep(50);
  assert.deepEqual(codes, [1000, 1000, 4000]);
  await client.close();
});

describe('flow control hardening (review findings)', () => {
  test('windows must be integers from 64 KiB to 2^31-1: server option, connection, client option', () => {
    for (const bad of [Number.NaN, 1.5e6 + 0.5, 1024, 2 ** 31, Infinity]) {
      assert.throws(() => checkWindow('w', bad), RangeError);
      const { key, cert } = testCert();
      assert.throws(() => createApueServer(api, handlers, { key, cert, webSocketWindow: bad }), /webSocketWindow must be an integer/);
      assert.throws(() => webSocketTransport('https://x.example', { receiveWindow: bad }), /receiveWindow must be an integer/);
    }
    assert.equal(checkWindow('w', WS_INITIAL_WINDOW), WS_INITIAL_WINDOW);
  });

  test('data beyond the window and oversized credit are rejected from the header, before buffering', async () => {
    const big = await rawWs('/stall.client');
    // header of a 16 MiB binary frame (masked), no payload: must close now, not after 16 MiB
    const header = Buffer.alloc(14);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(16 * 1024 * 1024 - 1), 2);
    big.socket.write(header);
    assert.equal(await closeCodeForFrames(big.frames()), 1008);
    const text = await rawWs('/stall.client');
    const textHeader = Buffer.from([0x81, 0x80 | 120, 0, 0, 0, 0]); // 120-byte "credit"
    text.socket.write(textHeader);
    assert.equal(await closeCodeForFrames(text.frames()), 1002);
  });

  test('fragmentation rules (RFC 6455 §5.4): credit inside a message, stray continuation, nested message → 1002', async () => {
    const inside = await rawWs('/sum.client');
    inside.send(0x2, msgFrame(1).subarray(0, 3), { fin: false });
    inside.send(0x1, Buffer.from('65536'));
    assert.equal(await closeCodeForFrames(inside.frames()), 1002);
    const stray = await rawWs('/sum.client');
    stray.send(0x0, msgFrame(1));
    assert.equal(await closeCodeForFrames(stray.frames()), 1002);
    const nested = await rawWs('/sum.client');
    nested.send(0x2, msgFrame(1).subarray(0, 3), { fin: false });
    nested.send(0x2, msgFrame(1));
    assert.equal(await closeCodeForFrames(nested.frames()), 1002);
  });

  test('a ping flood from a peer that never reads stops the reader instead of growing the write buffer', async () => {
    const io = new Duplex({ read() {}, write() {} }); // our writes never complete: the peer doesn't read
    new WsConnection(io);
    const ping = Buffer.alloc(2 + 4 + 100);
    ping[0] = 0x89;
    ping[1] = 0x80 | 100; // masked, 100-byte payload, mask key 0
    const flood = Buffer.concat(Array.from({ length: 1000 }, () => ping)); // 1000 pings per chunk
    for (let i = 0; i < 40; i++) io.push(flood); // 40,000 pings → 4 MiB of pongs if all were answered
    await sleep(100);
    assert.ok(io.writableLength < 1.2 * 1024 * 1024, `write buffer grew to ${io.writableLength}`);
    assert.ok(io.readableLength > 0, 'the reader kept reading');
    io.destroy();
  });

  test('handshake without our subprotocol: clean error, no leaked listeners; already-aborted signal: no connection', async () => {
    const { key, cert } = testCert();
    let upgrades = 0;
    const sockets: Array<{ destroy(): void }> = [];
    const bare = https.createServer({ key, cert });
    bare.on('upgrade', (req, socket) => {
      upgrades++;
      sockets.push(socket);
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on('data', () => {});
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${(bare.address() as { port: number }).port}`;
    const transport = webSocketTransport(url);
    const controller = new AbortController();
    const request = { method: 'POST', path: '/x', headers: {}, body: numbers(1), signal: controller.signal } as unknown as Parameters<typeof transport.request>[0];
    try {
      // undici (like browsers, per the WHATWG spec) fails a handshake that omits a requested subprotocol
      await assert.rejects(transport.request(request), /WebSocket connection to .* failed/);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      controller.abort();
      await assert.rejects(transport.request(request), (e: Error) => e.name === 'AbortError');
      assert.equal(upgrades, 1);
    } finally {
      for (const socket of sockets) socket.destroy(); // upgraded sockets keep server.close() waiting
      await new Promise((resolve) => bare.close(resolve));
    }
  });

  test('an implementation that opens with another subprotocol: error, browser-legal close code', async () => {
    const closes: number[] = [];
    class OtherProtocol {
      static OPEN = 1;
      OPEN = 1;
      CONNECTING = 0;
      readyState = 0;
      protocol = 'chat';
      binaryType = 'blob';
      onopen?: () => void;
      onerror?: () => void;
      onmessage?: () => void;
      onclose?: () => void;
      constructor() {
        setTimeout(() => ((this.readyState = 1), this.onopen?.()), 1);
      }
      close(code: number) {
        if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('invalid code', 'InvalidAccessError'); // as browsers do
        closes.push(code);
        this.readyState = 3;
      }
    }
    const transport = webSocketTransport('https://x.example', { WebSocketImpl: OtherProtocol as unknown as typeof WebSocket });
    const signal = new AbortController().signal;
    await assert.rejects(transport.request({ method: 'POST', path: '/x', headers: {}, body: numbers(1), signal } as unknown as Parameters<typeof transport.request>[0]), /did not accept subprotocol apue\.v1/);
    assert.deepEqual(closes, [4002]);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  });

  test('a server granting a huge window cannot make the browser buffer the whole upload', async () => {
    // Fake WebSocket: the server grants 1 GiB at once; the link drains 64 KiB per ms.
    let maxUnsent = 0;
    let sent = 0;
    class SlowLink {
      static OPEN = 1;
      OPEN = 1;
      readyState = 0;
      protocol = 'apue.v1';
      binaryType = 'blob';
      onopen?: () => void;
      onmessage?: (e: { data: unknown }) => void;
      onclose?: (e: { code: number; reason: string }) => void;
      onerror?: () => void;
      #unsent = 0;
      #last = performance.now();
      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          this.onmessage?.({ data: String(2 ** 30) });
        }, 1);
      }
      get bufferedAmount() {
        const now = performance.now();
        const drained = Math.min(this.#unsent, (now - this.#last) * 64 * 1024);
        this.#unsent -= drained;
        sent += drained;
        this.#last = now;
        return this.#unsent;
      }
      send(data: string | Uint8Array) {
        if (typeof data === 'string') return;
        void this.bufferedAmount; // account for draining up to now
        this.#unsent += data.byteLength;
        maxUnsent = Math.max(maxUnsent, this.#unsent);
      }
      close() {
        this.readyState = 3;
      }
    }
    const transport = webSocketTransport('https://x.example', { WebSocketImpl: SlowLink as unknown as typeof WebSocket });
    const total = 32 * 1024 * 1024;
    async function* upload() {
      for (let i = 0; i < total / (256 * 1024); i++) yield new Uint8Array(256 * 1024);
    }
    const controller = new AbortController();
    await transport.request({ method: 'POST', path: '/up', headers: {}, body: upload(), signal: controller.signal } as Parameters<typeof transport.request>[0]);
    const deadline = Date.now() + 5000;
    let link: { bufferedAmount: number } | undefined;
    while (sent < total - MAX_UNSENT - 256 * 1024 && Date.now() < deadline) await sleep(20);
    void link;
    assert.ok(maxUnsent <= MAX_UNSENT + 256 * 1024, `browser buffered up to ${(maxUnsent / 1048576).toFixed(1)} MiB`);
    controller.abort();
  });
});

test('small stream messages are coalesced into few sends; a lone message still leaves within milliseconds', async () => {
  const sends: Array<{ at: number; bytes: number }> = [];
  class Recorder {
    static OPEN = 1;
    OPEN = 1;
    CONNECTING = 0;
    readyState = 0;
    protocol = 'apue.v1';
    binaryType = 'blob';
    bufferedAmount = 0;
    onopen?: () => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor() {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: String(2 ** 24) }); // plenty of credit
      }, 1);
    }
    send(data: string | Uint8Array) {
      if (typeof data !== 'string') sends.push({ at: performance.now(), bytes: data.byteLength });
    }
    close() {
      this.readyState = 3;
    }
  }
  const transport = webSocketTransport('https://x.example', { WebSocketImpl: Recorder as unknown as typeof WebSocket });
  const request = (body: AsyncIterable<Uint8Array>) =>
    transport.request({ method: 'POST', path: '/x', headers: {}, body, signal: new AbortController().signal } as unknown as Parameters<typeof transport.request>[0]);

  async function* burst() {
    for (let i = 0; i < 10_000; i++) yield msgFrame(i); // ~14 bytes each, 140 KB in total
  }
  await request(burst());
  await sleep(50);
  const total = sends.reduce((sum, s) => sum + s.bytes, 0);
  assert.equal(total, concatBytes(Array.from({ length: 10_000 }, (_, i) => msgFrame(i))).byteLength);
  assert.ok(sends.length <= 20, `${sends.length} sends for 10,000 messages`); // one per message before

  sends.length = 0;
  let yieldedAt = 0;
  let release!: () => void;
  async function* lone() {
    yieldedAt = performance.now();
    yield msgFrame('only');
    await new Promise<void>((resolve) => (release = resolve)); // the producer then waits
  }
  await request(lone());
  await sleep(30);
  assert.equal(sends.length, 1);
  assert.ok(sends[0]!.at - yieldedAt < 10, `lone message sent after ${(sends[0]!.at - yieldedAt).toFixed(1)} ms`);
  release();
});

describe('second review (b91f057..HEAD)', () => {
  /** A fake WebSocket: opens, grants `credit` once, records binary sends; `send` may throw. */
  function fakeSocket(options: { credit?: number; sendThrows?: boolean; closeAfterMs?: number } = {}) {
    const state = { sends: 0, bytes: 0, instance: undefined as unknown as { readyState: number; onclose?: (e: { code: number; reason: string }) => void } };
    class Fake {
      static OPEN = 1;
      OPEN = 1;
      CONNECTING = 0;
      readyState = 0;
      protocol = 'apue.v1';
      binaryType = 'blob';
      bufferedAmount = 0;
      onopen?: () => void;
      onmessage?: (e: { data: unknown }) => void;
      onclose?: (e: { code: number; reason: string }) => void;
      onerror?: () => void;
      constructor() {
        state.instance = this;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          if (options.credit) this.onmessage?.({ data: String(options.credit) });
          if (options.closeAfterMs !== undefined) {
            setTimeout(() => {
              this.readyState = 3;
              this.onclose?.({ code: 1000, reason: '' });
            }, options.closeAfterMs);
          }
        }, 1);
      }
      send(data: string | Uint8Array) {
        if (typeof data === 'string') return;
        if (options.sendThrows) throw new DOMException('send in a bad state', 'InvalidStateError');
        state.sends++;
        state.bytes += data.byteLength;
      }
      close(code = 1000, reason = '') {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setTimeout(() => this.onclose?.({ code, reason }), 1); // as browsers: 'close' follows asynchronously
      }
    }
    return { state, WebSocketImpl: Fake as unknown as typeof WebSocket };
  }
  const requestWith = (transport: ReturnType<typeof webSocketTransport>, body: AsyncIterable<Uint8Array>) =>
    transport.request({ method: 'POST', path: '/x', headers: {}, body, signal: new AbortController().signal } as unknown as Parameters<typeof transport.request>[0]);

  test('streamWindow below 64 KiB (valid for HTTP/2) no longer breaks startup', () => {
    const { key, cert } = testCert();
    assert.doesNotThrow(() => createApueServer(api, handlers, { key, cert, streamWindow: 65_535 }));
  });

  test('coalescing keeps backpressure: a slow producer is not drained while sends wait for credit', async () => {
    const { WebSocketImpl, state } = fakeSocket(); // only the implicit 64 KiB window, never more credit
    let yielded = 0;
    async function* trickle() {
      for (;;) {
        yielded++;
        yield new Uint8Array(1024);
        await sleep(1);
      }
    }
    await requestWith(webSocketTransport('https://x.example', { WebSocketImpl }), trickle());
    await sleep(400);
    // 64 KiB of credit + up to 16 KiB queued + one chunk; unbounded before (~1 per ms)
    state.instance.readyState = 3;
    state.instance.onclose?.({ code: 1006, reason: '' }); // end the call (the pump would wait for credit forever)
    assert.ok(yielded <= 64 + 16 + 4, `producer yielded ${yielded} KiB while no credit came`);
  });

  test('a closed socket stops pulling the producer and releases the MessagePort', async () => {
    const { WebSocketImpl } = fakeSocket({ credit: 2 ** 20, closeAfterMs: 30 });
    let yielded = 0;
    async function* heartbeat() {
      for (;;) {
        yielded++;
        yield msgFrame('beat');
        await sleep(5);
      }
    }
    const ports = () => process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
    const before = ports();
    await requestWith(webSocketTransport('https://x.example', { WebSocketImpl }), heartbeat());
    await sleep(100);
    const atClose = yielded;
    await sleep(100);
    assert.ok(yielded - atClose <= 1, `producer still pulled: ${atClose} → ${yielded}`);
    assert.ok(ports() <= before, `MessagePorts ${before} → ${ports()}`); // ≤: an earlier test's port may close meanwhile
  });

  test('a throwing send fails the call with that error; no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const { WebSocketImpl } = fakeSocket({ credit: 2 ** 20, sendThrows: true });
      const response = await requestWith(webSocketTransport('https://x.example', { WebSocketImpl }), numbersAsFrames(3));
      await assert.rejects(Array.fromAsync(response.body), /send in a bad state/);
      await sleep(20);
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('close(): closes live WebSockets, leaves a caller-supplied (possibly shared) http transport open', async () => {
    let httpClosed = 0;
    const http = { request: () => Promise.reject(new Error('unused')), close: async () => void httpClosed++ };
    const { WebSocketImpl, state } = fakeSocket({ credit: 2 ** 20 });
    const transport = webSocketTransport('https://x.example', { http, WebSocketImpl });
    let release: (() => void) | undefined;
    async function* waiting() {
      yield msgFrame(1);
      await new Promise<void>((resolve) => (release = resolve));
    }
    await requestWith(transport, waiting());
    const codes: number[] = [];
    const close = (state.instance as unknown as { close(code: number): void }).close.bind(state.instance);
    (state.instance as unknown as { close(code: number): void }).close = (code: number) => (codes.push(code), close(code));
    await transport.close?.();
    assert.deepEqual(codes, [4000]);
    assert.equal(httpClosed, 0);
    release?.(); // the pump stopped pulling, so the producer may never have reached its wait
  });

  test('a protocol error destroys the transport even if the peer stays connected', async () => {
    const ws = await rawWs('/sum.client');
    ws.socket.allowHalfOpen = true; // a peer that stays connected after the server's FIN
    ws.socket.on('error', () => {});
    const closed = new Promise((resolve) => ws.socket.once('close', resolve));
    ws.send(0x2, msgFrame(1), { mask: false }); // unmasked → 1002; we never answer or close
    for await (const frame of ws.frames()) if (frame.opcode === 0x8) break;
    // Only a really closed server socket answers further client data with a reset; a half-open
    // one (end() alone) keeps accepting it silently. Keep writing until the reset (slow under load).
    let isClosed = false;
    void closed.then(() => (isClosed = true));
    for (const deadline = Date.now() + 3000; !isClosed && Date.now() < deadline; await sleep(50)) {
      if (!ws.socket.destroyed) ws.socket.write(Buffer.alloc(1024));
    }
    assert.ok(isClosed, 'the server kept the transport half-open');
  });

  // Documents behaviour: in Node, 'close' (→ 499) is handled before the reader's catch sees the reset,
  // so this holds with or without the reader's own isClientGone branch (kept as defence).
  test('a transport reset during a WebSocket call is 499 (client gone), not 400', async () => {
    const io = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    const conn = new WsConnection(io);
    const input = Array.fromAsync(conn);
    io.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await assert.rejects(input, (e: ApueError) => e.status === 499);
  });

  test('a protocol error ends the transport at once (no 2 s close handshake wait)', async () => {
    const ws = await rawWs('/sum.client');
    const start = performance.now();
    ws.send(0x1, Buffer.from('not credit'));
    for await (const frame of ws.frames()) if (frame.opcode === 0x8) ws.send(0x8, frame.payload);
    assert.ok(performance.now() - start < 500, `transport ended after ${(performance.now() - start).toFixed(0)} ms`);
  });
});

async function* numbersAsFrames(n: number) {
  for (let i = 0; i < n; i++) yield msgFrame(i);
}

async function closeCodeForFrames(frames: AsyncGenerator<{ opcode: number; payload: Uint8Array }>): Promise<number> {
  for await (const frame of frames) if (frame.opcode === 0x8) return Buffer.from(frame.payload).readUInt16BE(0);
  return 0;
}

void decodeFrames;
