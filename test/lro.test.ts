// The long-running-operation pattern from SPEC §8, end to end: idempotent start, resumable
// watch (exactly once across a connection loss), cacheable polling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport } from '../src/client.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const JobEvent = t.object({ seq: t.number(), progress: t.number(), result: t.optional(t.string()) });
const api = defineApi({
  'reports.start': op({ effect: 'unsafe', input: t.object({ name: t.string() }), output: t.object({ jobId: t.string() }) }),
  'reports.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ jobId: t.string() }), output: JobEvent }),
  'reports.get': op({ effect: 'safe', input: t.object({ jobId: t.string() }), output: t.object({ progress: t.number(), done: t.boolean() }) }),
});

interface Job {
  events: Array<{ seq: number; progress: number; result?: string }>;
  done: boolean;
  wake: Set<() => void>;
}
const jobs = new Map<string, Job>();
let started = 0;

const handlers: Handlers<typeof api> = {
  'reports.start': ({ name }) => {
    started++;
    const jobId = `job-${started}`;
    const job: Job = { events: [], done: false, wake: new Set() };
    jobs.set(jobId, job);
    void (async () => {
      for (let step = 1; step <= 20; step++) {
        await sleep(5);
        job.events.push({ seq: job.events.length, progress: step * 5, ...(step === 20 ? { result: `report ${name}` } : {}) });
        if (step === 20) job.done = true;
        for (const wake of job.wake) wake();
      }
    })();
    return { jobId };
  },
  'reports.watch': async function* ({ jobId }, ctx) {
    const job = jobs.get(jobId)!;
    let seq = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1;
    for (;;) {
      while (seq < job.events.length) {
        yield job.events[seq]!;
        ctx.checkpoint(String(seq++));
      }
      if (job.done) return;
      let wake!: () => void;
      await new Promise<void>((resolve) => job.wake.add((wake = resolve)));
      job.wake.delete(wake); // only our own waiter: other watchers stay registered
    }
  },
  'reports.get': ({ jobId }) => {
    const job = jobs.get(jobId)!;
    return { progress: job.events.at(-1)?.progress ?? 0, done: job.done };
  },
};

/** Drops the first watch response after `cutAfter` bytes (one simulated connection loss). */
const watchRequests: string[] = [];
function lossy(inner: Transport, cutAfter: number): Transport {
  let cut = false;
  return {
    async request(req) {
      if (req.path.startsWith('/reports.watch')) watchRequests.push(req.headers['apue-resume'] ? 'resume' : 'initial');
      const res = await inner.request(req);
      if (cut || !req.path.startsWith('/reports.watch')) return res;
      cut = true;
      const body = res.body;
      return {
        ...res,
        body: (async function* () {
          let sent = 0;
          for await (const chunk of body) {
            if (sent + chunk.byteLength >= cutAfter) {
              yield chunk.subarray(0, cutAfter - sent);
              throw new Error('ECONNRESET (simulated)');
            }
            sent += chunk.byteLength;
            yield chunk;
          }
        })(),
      };
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
}

test('long-running operation: idempotent start, resumable watch, cacheable polling', async () => {
  const server = await startServer(api, handlers);
  const client = new ApueClient(api, lossy(http2Transport(server.url, { ca: testCert().cert, acceptEncoding: '' }), 900), { backoffMs: 5 });

  // A retried start with the same key starts one job only.
  const first = await client.call('reports.start', { name: 'q3' }, { idempotencyKey: 'start-q3' });
  const again = await client.call('reports.start', { name: 'q3' }, { idempotencyKey: 'start-q3' });
  assert.deepEqual(again, first);
  assert.equal(started, 1);

  // Watching survives a connection loss: every event exactly once, then the result.
  const events = await Array.fromAsync(client.stream('reports.watch', first));
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(events.at(-1)?.result, 'report q3');
  assert.deepEqual(watchRequests, ['initial', 'resume']); // the loss really happened and was resumed

  // Polling clients: GET with ETag; an unchanged state revalidates as 304.
  const path = `/reports.get?i=${encodeURIComponent(JSON.stringify(first))}`;
  const polled = await fetch(`${server.url}${path}`);
  assert.deepEqual(await polled.json(), { progress: 100, done: true });
  const revalidated = await fetch(`${server.url}${path}`, { headers: { 'if-none-match': polled.headers.get('etag')! } });
  assert.equal(revalidated.status, 304);

  await client.close();
  await server.close();
});
