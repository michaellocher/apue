// Tier T3: apü calls over WebSocket (RFC 8441 over HTTP/2 and RFC 6455 Upgrade over HTTP/1.1).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import tls from 'node:tls';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { decodeFrames, decodeJson, endFrame, FrameDecoder, FrameType, msgFrame, concatBytes } from '../src/frame.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { webSocketTransport } from '../src/transport-ws.ts';
import { encodeWsFrame, WsParser } from '../src/websocket.ts';
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

void decodeFrames;
void WsParser;
