// S1 measurement: TTFB of buffered-unary vs apü streaming, and small-message throughput with and
// without frame coalescing. Local loopback over TLS + HTTP/2, warm connection.
//   node scripts/ttfb.ts [--rows 20] [--rowMs 10] [--runs 30] [--messages 200000]
import { parseArgs } from 'node:util';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport } from '../src/client.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { sleep, startServer, transports } from '../test/helpers.ts';

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '20' },
    rowMs: { type: 'string', default: '10' },
    runs: { type: 'string', default: '30' },
    messages: { type: 'string', default: '200000' },
  },
});
const rows = Number(values.rows);
const rowMs = Number(values.rowMs);
const runs = Number(values.runs);
const messages = Number(values.messages);

// Simulates a DB cursor that produces one row every `rowMs`.
async function* cursor(): AsyncGenerator<{ id: number; name: string; total: number }> {
  for (let id = 1; id <= rows; id++) {
    await sleep(rowMs);
    yield { id, name: `customer ${id}`, total: id * 9.99 };
  }
}

const Row = t.object({ id: t.number(), name: t.string(), total: t.number() });
const api = defineApi({
  'report.buffered': op({ effect: 'safe', input: t.void(), output: t.array(Row) }),
  'report.stream': op({ effect: 'safe', stream: 'server', input: t.void(), output: Row }),
  'flood.stream': op({ effect: 'safe', stream: 'server', input: t.object({ n: t.number() }), output: t.object({ i: t.number(), name: t.string(), ok: t.boolean() }) }),
});

const handlers: Handlers<typeof api> = {
  'report.buffered': () => Array.fromAsync(cursor()),
  'report.stream': () => cursor(),
  'flood.stream': async function* ({ n }) {
    for (let i = 0; i < n; i++) yield { i, name: 'item', ok: true };
  },
};

interface Sample {
  ttfb: number;
  total: number;
}

async function measure(fn: () => AsyncIterable<unknown> | Promise<unknown>): Promise<Sample> {
  const started = performance.now();
  const result = fn();
  if (result instanceof Promise) {
    await result;
    const total = performance.now() - started;
    return { ttfb: total, total };
  }
  let ttfb = NaN;
  for await (const _ of result) if (Number.isNaN(ttfb)) ttfb = performance.now() - started;
  return { ttfb, total: performance.now() - started };
}

function stats(samples: number[]): { p50: number; p95: number } {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95) };
}

const fmt = (ms: number) => `${ms.toFixed(1).padStart(7)} ms`;

async function ttfbTable(name: string, transport: Transport): Promise<void> {
  const client = new ApueClient(api, transport);
  const cases: Array<[string, () => AsyncIterable<unknown> | Promise<unknown>]> = [
    ['unary, buffered', () => client.call('report.buffered')],
    ['apü stream', () => client.stream('report.stream')],
  ];
  for (const [label, fn] of cases) {
    for (let i = 0; i < 3; i++) await measure(fn); // warm-up (connection, JIT)
    const samples: Sample[] = [];
    for (let i = 0; i < runs; i++) samples.push(await measure(fn));
    const ttfb = stats(samples.map((s) => s.ttfb));
    const total = stats(samples.map((s) => s.total));
    console.log(
      `${name.padEnd(6)} ${label.padEnd(16)} TTFB p50 ${fmt(ttfb.p50)}  p95 ${fmt(ttfb.p95)}   total p50 ${fmt(total.p50)}`,
    );
  }
  await client.close();
}

async function throughput(label: string, coalesceBytes: number): Promise<void> {
  const server = await startServer(api, handlers, { coalesceBytes });
  const client = new ApueClient(api, new Map(transports(server.url)).get('http2')!);
  await Array.fromAsync(client.stream('flood.stream', { n: 1000 })); // warm-up
  const rates: number[] = [];
  for (let i = 0; i < 3; i++) {
    const { total } = await measure(() => client.stream('flood.stream', { n: messages }));
    rates.push(messages / (total / 1000));
  }
  const best = Math.max(...rates);
  console.log(`${label.padEnd(30)} ${Math.round(best).toLocaleString('en').padStart(10)} msg/s`);
  await client.close();
  await server.close();
}

console.log(`Node ${process.version} — ${rows} rows × ${rowMs} ms, ${runs} runs, loopback TLS + h2\n`);
const server = await startServer(api, handlers);
for (const [name, transport] of transports(server.url)) await ttfbTable(name, transport);
await server.close();

console.log(`\nServer → client stream of ${messages.toLocaleString('en')} small messages (http2 transport):`);
await throughput('coalescing 16 KiB (default)', 16 * 1024);
await throughput('no coalescing (1 write/frame)', 0);
