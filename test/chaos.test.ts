// Network-level misbehaviour must never crash the server or leave it unable to serve.
// (Born from a real crash: Envoy's INTERNAL_ERROR resets — see docs/intermediaries.md.)
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import https from 'node:https';
import { after, before, test } from 'node:test';
import tls from 'node:tls';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { msgFrame } from '../src/frame.ts';
import { isClientGone } from '../src/server.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const api = defineApi({
  'ping': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'ticker': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'echo.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.number() }),
  'buggy.after.cancel': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'waits.with.signal': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
});
const handlers: Handlers<typeof api> = {
  'ping': () => 'pong',
  'ticker': async function* () {
    for (let i = 0; ; i++) {
      yield i;
      await sleep(2);
    }
  },
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'echo.duplex': async function* (inputs) {
    for await (const n of inputs) yield n;
  },
  'waits.with.signal': async function* (_input, ctx) {
    yield 1;
    await delay(60_000, undefined, { signal: ctx.signal }); // rejects with Node's AbortError on disconnect
    yield 2;
  },
  'buggy.after.cancel': async function* (_input, ctx) {
    yield 1;
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    throw new TypeError('bug after cancel');
  },
};

let server: { url: string; close(): Promise<void> };
const uncaught: Error[] = [];
const monitor = (error: Error) => uncaught.push(error);
before(async () => {
  process.on('uncaughtExceptionMonitor', monitor);
  server = await startServer(api, handlers);
});
after(async () => {
  process.off('uncaughtExceptionMonitor', monitor);
  await server.close();
});

const port = () => Number(new URL(server.url).port);
const rawTls = (alpn: string) =>
  new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: port(), ca: testCert().cert, ALPNProtocols: [alpn] }, () => resolve(socket));
    socket.on('error', () => {});
    socket.once('error', reject);
  });

async function stillServing(): Promise<void> {
  const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
  assert.equal(await client.call('ping'), 'pong');
  await client.close();
  await sleep(50);
  assert.deepEqual(uncaught.map((e) => e.message), []);
}

test('HTTP/2: garbage after the preface, and no preface at all', async () => {
  for (const bytes of [Buffer.concat([Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'), Buffer.from([0, 0, 4, 0xff, 0xff, 0, 0, 0, 1, 1, 2, 3, 4])]), Buffer.from('hello, not http/2 at all\r\n\r\n')]) {
    const socket = await rawTls('h2');
    socket.write(bytes);
    await sleep(50);
    socket.destroy();
  }
  await stillServing();
});

test('TCP connection dropped in the middle of a streamed response (h2 and HTTP/1.1)', async () => {
  const session = http2.connect(server.url, { ca: testCert().cert });
  session.on('error', () => {});
  const req = session.request({ ':path': '/ticker', accept: 'application/apue+json' });
  req.on('error', () => {});
  await new Promise((resolve) => req.once('data', resolve));
  session.socket.destroy();
  await new Promise<void>((resolve, reject) => {
    const h1 = https.get(`${server.url}/ticker`, { ca: testCert().cert, headers: { accept: 'application/apue+json' } }, (res) => {
      res.once('data', () => {
        res.socket.destroy();
        resolve();
      });
    });
    h1.on('error', (e) => (e.message.includes('socket hang up') ? resolve() : reject(e)));
  });
  await stillServing();
});

test('GOAWAY with an error code while streams are open', async () => {
  const session = http2.connect(server.url, { ca: testCert().cert });
  session.on('error', () => {});
  const stream = session.request({ ':path': '/ticker', accept: 'application/apue+json' });
  stream.on('error', () => {});
  const upload = session.request({ ':method': 'POST', ':path': '/sum.client', 'content-type': 'application/apue+json' });
  upload.on('error', () => {});
  upload.write(msgFrame(1));
  await new Promise((resolve) => stream.once('data', resolve));
  session.goaway(http2.constants.NGHTTP2_INTERNAL_ERROR);
  await sleep(50);
  session.destroy();
  await stillServing();
});

test('HTTP/1.1: incomplete headers, then a body cut off mid-frame', async () => {
  const half = await rawTls('http/1.1');
  half.write('POST /sum.client HTTP/1.1\r\nHost: x\r\nContent-Type: application/apue+');
  await sleep(30);
  half.destroy();
  const cut = await rawTls('http/1.1');
  cut.write('POST /sum.client HTTP/1.1\r\nHost: x\r\nContent-Type: application/apue+json\r\nTransfer-Encoding: chunked\r\n\r\n');
  const frame = msgFrame(41);
  cut.write(`${frame.byteLength.toString(16)}\r\n`);
  cut.write(frame.subarray(0, 5)); // half a chunk, half a frame
  await sleep(30);
  cut.destroy();
  await stillServing();
});

test('WebSocket dropped in the middle of a frame', async () => {
  const socket = await rawTls('http/1.1');
  socket.write(
    'GET /echo.duplex HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: apue.v1\r\n\r\n',
  );
  await new Promise((resolve) => socket.once('data', resolve)); // 101
  socket.write(Buffer.from([0x82, 0xfe, 0x01, 0x00, 1, 2, 3, 4, 9, 9])); // masked binary frame announcing 256 bytes, then gone
  await sleep(30);
  socket.destroy();
  await stillServing();
});

test('client: closing right after a call failed client-side, before the h2 session connected', async () => {
  // 'connect' fired on the destroyed session and setLocalWindowSize threw from the event handler:
  // an uncaught exception in the client process (20 of 20 tries before the fix).
  for (let i = 0; i < 10; i++) {
    const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));
    async function* invalid() {
      yield 'not a number' as unknown as number;
    }
    await assert.rejects(Array.fromAsync(client.duplex('echo.duplex', invalid())), (e: { status: number }) => e.status === 400);
    await client.close();
  }
  await sleep(100);
  await stillServing();
});

test('a client resetting its request stream mid-call is a 499 for the handler, not a logged server error', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  for (const code of [http2.constants.NGHTTP2_CANCEL, http2.constants.NGHTTP2_INTERNAL_ERROR]) {
    const session = http2.connect(server.url, { ca: testCert().cert });
    session.on('error', () => {});
    const req = session.request({ ':method': 'POST', ':path': '/echo.duplex', 'content-type': 'application/apue+json' });
    req.on('error', () => {});
    req.write(msgFrame(1));
    await new Promise((resolve) => req.once('data', resolve)); // the echo: the handler is running
    req.close(code);
    await sleep(100);
    session.destroy();
  }
  assert.deepEqual(logged.mock.calls.map((c) => String(c.arguments[1] ?? c.arguments[0])), []);
  await stillServing();
});

test('a handler bug is still logged when the client is already gone', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const session = http2.connect(server.url, { ca: testCert().cert });
  session.on('error', () => {});
  const req = session.request({ ':path': '/buggy.after.cancel', accept: 'application/apue+json' });
  req.on('error', () => {});
  await new Promise((resolve) => req.once('data', resolve));
  req.close(http2.constants.NGHTTP2_CANCEL);
  await sleep(100);
  session.destroy();
  assert.ok(logged.mock.calls.some((c) => String(c.arguments[1]).includes('bug after cancel')), 'the TypeError was not logged');
});

test('a handler awaiting with ctx.signal (AbortError on disconnect) is not logged as a server failure', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const session = http2.connect(server.url, { ca: testCert().cert });
  session.on('error', () => {});
  const req = session.request({ ':path': '/waits.with.signal', accept: 'application/apue+json' });
  req.on('error', () => {});
  await new Promise((resolve) => req.once('data', resolve));
  req.close(http2.constants.NGHTTP2_CANCEL);
  await sleep(100);
  session.destroy();
  assert.deepEqual(logged.mock.calls.map((c) => String(c.arguments[1] ?? c.arguments[0])), []);
});

test('isClientGone: transport resets only, not server bugs', () => {
  for (const code of ['ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_GOAWAY_SESSION', 'ECONNABORTED', 'ETIMEDOUT', 'ABORT_ERR']) assert.equal(isClientGone(Object.assign(new Error(code), { code })), true);
  for (const code of ['ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP2_STREAM_ERROR', 'ECONNRESET']) assert.equal(isClientGone(Object.assign(new Error(code), { code })), true);
  assert.equal(isClientGone(new TypeError('x is not a function')), false);
  assert.equal(isClientGone(undefined), false);
});
