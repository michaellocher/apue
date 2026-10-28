// Many calls of every kind must not leak memory, listeners, timers or handles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: t.object({ id: t.string() }) }),
  'ticker': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'slow': op({ effect: 'safe', input: t.void(), output: t.string() }),
});
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id }),
  'ticker': async function* (_input, ctx) {
    for (let i = 0; !ctx.signal.aborted; i++) {
      yield i;
      await sleep(1);
    }
  },
  'slow': async (_input, ctx) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      ctx.signal.addEventListener('abort', () => (clearTimeout(timer), resolve(undefined)), { once: true });
    });
    return 'late';
  },
};

test('10,000 mixed calls: bounded heap growth, no leftover handles', { timeout: 120_000 }, async (t) => {
  const server = await startServer(api, handlers);
  const client = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }));

  async function round(calls: number) {
    for (let i = 0; i < calls; i += 5) {
      await client.call('users.get', { id: String(i) });
      for await (const n of client.stream('ticker')) if (n === 2) break; // cancel mid-stream
      const batch = client.batch();
      const a = batch.call('users.get', { id: 'a' });
      batch.call('users.get', { id: a.ref('id') });
      await batch.send();
      await client.call('slow', undefined, { timeoutMs: 1 }).catch((e: ApueError) => assert.equal(e.status, 504));
      await client.call('users.get', { id: 1 as unknown as string }).catch((e: ApueError) => assert.equal(e.status, 400));
    }
  }

  await round(1_000); // warm-up: JIT, pools, caches
  await sleep(200);
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const handlesBefore = process.getActiveResourcesInfo().length;

  await round(10_000);
  await sleep(500); // let aborted handlers and timers settle
  gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const handlesAfter = process.getActiveResourcesInfo().length;

  const growthMiB = (heapAfter - heapBefore) / 1024 / 1024;
  t.diagnostic(`heap ${(heapBefore / 1048576).toFixed(1)} → ${(heapAfter / 1048576).toFixed(1)} MiB (${growthMiB.toFixed(2)} MiB), handles ${handlesBefore} → ${handlesAfter}`);
  assert.ok(growthMiB < 4, `heap grew by ${growthMiB.toFixed(1)} MiB over 10,000 calls`);
  assert.ok(handlesAfter <= handlesBefore + 2, `active handles ${handlesBefore} → ${handlesAfter}: ${process.getActiveResourcesInfo().join(', ')}`);

  await client.close();
  await server.close();
});
