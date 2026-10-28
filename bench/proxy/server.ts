// apü server for intermediary probes; runs in a container behind the proxy under test.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApueServer, type Handlers } from '../../src/server.ts';
import { proxyApi } from './api.ts';

let cancelled = 0;
let flooded = 0;
// Random (base64): 'x'.repeat() compressed ~1000× under the gzip Caddy's upstream transport adds on
// its own, which made the stream fit inside every window (the "125 MiB ahead" artifact).
const ITEM = randomBytes(48 * 1024).toString('base64'); // 64 KiB of text
const FLOOD_ITEMS = Number(process.env.FLOOD_ITEMS ?? 2000); // 2000 × 64 KiB = 125 MiB
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const handlers: Handlers<typeof proxyApi> = {
  'users.get': ({ id }) => ({ id }),
  'users.search': ({ tags }) => tags.length,
  'orders.create': () => 1,
  'slow.stream': async function* () {
    yield 1; // immediately
    await sleep(1500);
    yield 2;
  },
  'ticker': async function* (_input, ctx) {
    ctx.signal.addEventListener('abort', () => cancelled++);
    for (let i = 0; ; i++) {
      yield i;
      await sleep(10);
    }
  },
  'stats.cancelled': () => cancelled,
  'echo.duplex': async function* (inputs) {
    for await (const n of inputs) yield n;
  },
  'big.get': () => 'apü '.repeat(20_000),
  // 64 KiB items as fast as the transport takes them: how far does the server get ahead of a
  // consumer that stalls? (HTTP/2 flow control is hop-by-hop; T3 credit is end-to-end.)
  'flood': async function* (inputs, ctx) {
    flooded = 0;
    if (process.env.APUE_DEBUG_STREAMS) {
      const started = Date.now();
      ctx.signal.addEventListener('abort', () => console.error(`[flood] aborted after ${Date.now() - started} ms at item ${flooded}: ${(ctx.signal.reason as Error)?.message}`));
    }
    for await (const _ of inputs) break;
    for (let i = 0; i < FLOOD_ITEMS; i++) {
      flooded++;
      yield ITEM;
    }
  },
  'stats.flooded': () => flooded,
};
const server = createApueServer(proxyApi, handlers, { key: readFileSync('certs/key.pem'), cert: readFileSync('certs/cert.pem'), heartbeatMs: 1000 });
if (process.env.APUE_DEBUG_STREAMS) {
  server.server.on('stream', (stream, headers) => {
    stream.on('close', () => console.error(`[stream] ${headers[':method']} ${headers[':path']} rst=${stream.rstCode} sent=${stream.sentHeaders?.[':status']} encoding=${stream.sentHeaders?.['content-encoding']} accept=${headers['accept-encoding']}`));
  });
}
await server.listen(8443, '0.0.0.0');
console.log('apue listening on 8443');
