// Probes how an intermediary treats apü traffic. Prints a Markdown table row per check.
//   node bench/proxy/check.ts --url https://127.0.0.1:18443 --ca cert.pem --label "nginx defaults"
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { ApueClient } from '../../src/client.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { webSocketTransport } from '../../src/transport-ws.ts';
import { proxyApi } from './api.ts';

const { values } = parseArgs({ options: { url: { type: 'string' }, ca: { type: 'string' }, label: { type: 'string', default: 'proxy' } } });
const url = values.url!;
const ca = readFileSync(values.ca!, 'utf8');
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca]); // for the WebSocket client
const client = new ApueClient(proxyApi, http2Transport(url, { ca, acceptEncoding: '' }), { retries: 0 });
const rows: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name: string, fn: () => Promise<string>) {
  const timeout = sleep(8000).then(() => 'TIMEOUT (8 s)');
  try {
    rows.push(`| ${name} | ${await Promise.race([fn(), timeout])} |`);
  } catch (error) {
    rows.push(`| ${name} | ✗ ${error instanceof Error ? error.message.slice(0, 120) : String(error)} |`);
  }
}

await check('unary GET (safe op)', async () => JSON.stringify(await client.call('users.get', { id: '1' })) === '{"id":"1"}' ? '✓' : '✗ wrong body');
await check('QUERY method (large read)', async () => {
  const session = http2.connect(url, { ca });
  session.on('error', () => {});
  const status = await new Promise<number>((resolve, reject) => {
    const req = session.request({ ':method': 'QUERY', ':path': '/users.search', 'content-type': 'application/json' });
    req.on('response', (h) => resolve(Number(h[':status'])));
    req.on('error', reject);
    req.end(JSON.stringify({ tags: Array.from({ length: 300 }, (_, i) => `t${i}`) }));
  });
  session.close();
  return status === 200 ? '✓ forwarded' : `✗ status ${status}`;
});
await check('unsafe POST + Idempotency-Key', async () => ((await client.call('orders.create', { item: 'x' })) === 1 ? '✓' : '✗'));
await check('stream: first item before the stream ends (TTFB)', async () => {
  const t0 = performance.now();
  let first = 0;
  for await (const n of client.stream('slow.stream')) if (n === 1) first = performance.now() - t0;
  const total = performance.now() - t0;
  return first < 1000 ? `✓ first item after ${first.toFixed(0)} ms (stream ${total.toFixed(0)} ms)` : `✗ buffered: first item after ${first.toFixed(0)} ms`;
});
await check('cancellation reaches the backend', async () => {
  const before = await client.call('stats.cancelled');
  for await (const n of client.stream('ticker')) if (n === 3) break;
  for (let i = 0; i < 40; i++) {
    if ((await client.call('stats.cancelled')) > before) return `✓ after ${i * 50} ms`;
    await sleep(50);
  }
  return '✗ backend never saw the cancel (keeps producing)';
});
await check('full duplex over HTTP/2 (request stream, tier T1)', async () => {
  let last = 0;
  async function* inputs() {
    for (let i = 1; i <= 3; i++) {
      yield i;
      const deadline = performance.now() + 3000;
      while (last < i) {
        if (performance.now() > deadline) throw new Error(`no echo for ${i} within 3 s (request buffered by proxy)`);
        await sleep(5);
      }
    }
  }
  for await (const n of client.duplex('echo.duplex', inputs())) last = n;
  return '✓ echoes arrived while the request was open';
});
await check('client stream as a whole (no duplex needed)', async () => {
  async function* inputs() {
    yield 1;
    yield 2;
  }
  const out = await Array.fromAsync(client.duplex('echo.duplex', inputs()));
  return JSON.stringify(out) === '[1,2]' ? '✓' : `✗ ${JSON.stringify(out)}`;
});
await check('WebSocket (tier T3)', async () => {
  const ws = new ApueClient(proxyApi, webSocketTransport(url));
  let last = 0;
  async function* inputs() {
    for (let i = 1; i <= 3; i++) {
      yield i;
      while (last < i) await sleep(5);
    }
  }
  for await (const n of ws.duplex('echo.duplex', inputs())) last = n;
  return '✓ full duplex';
});
await check('zstd response passes through', async () => {
  const session = http2.connect(url, { ca });
  session.on('error', () => {});
  const encoding = await new Promise<string>((resolve, reject) => {
    const req = session.request({ ':path': '/big.get', 'accept-encoding': 'zstd' });
    req.on('response', (h) => resolve(String(h['content-encoding'])));
    req.on('error', reject);
    req.resume();
    req.end();
  });
  session.close();
  return encoding === 'zstd' ? '✓ content-encoding: zstd' : `✗ content-encoding: ${encoding}`;
});

console.log(`\n#### ${values.label}\n\n| check | result |\n|---|---|\n${rows.join('\n')}`);
await client.close();
process.exit(0);
