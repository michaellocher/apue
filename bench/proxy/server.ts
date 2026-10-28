// apü server for intermediary probes; runs in a container behind the proxy under test.
import { readFileSync } from 'node:fs';
import { createApueServer, type Handlers } from '../../src/server.ts';
import { proxyApi } from './api.ts';

let cancelled = 0;
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
};
const server = createApueServer(proxyApi, handlers, { key: readFileSync('certs/key.pem'), cert: readFileSync('certs/cert.pem'), heartbeatMs: 1000 });
await server.listen(8443, '0.0.0.0');
console.log('apue listening on 8443');
