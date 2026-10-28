import assert from 'node:assert/strict';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { ApueClient } from '../src/client.ts';
import { decodeFrames, decodeJson, FrameType } from '../src/frame.ts';
import { ApueError, MediaType } from '../src/protocol.ts';
import { FrameWriter, type Handler } from '../src/server.ts';
import { sleep, startServer, testCert, transports } from './helpers.ts';

let cancelled: PromiseWithResolvers<string>;

const handlers: Record<string, Handler> = {
  'math.add': ({ a, b }: { a: number; b: number }) => a + b,
  'meta.version': (_input, ctx) => ({ httpVersion: ctx.httpVersion }),
  'count.up': async function* ({ to }: { to: number }) {
    for (let i = 1; i <= to; i++) yield i;
  },
  'count.failAt': async function* ({ at }: { at: number }) {
    for (let i = 1; ; i++) {
      if (i === at) throw new ApueError(409, 'Conflict', `failed at ${i}`);
      yield i;
    }
  },
  'fail.early': async function* () {
    throw new ApueError(403, 'Forbidden', 'not for you');
  },
  'slow.first': async function* () {
    await sleep(300);
    yield 'late';
  },
  'slow.unary': async (_input, ctx) => {
    await sleep(2_000);
    return ctx.signal.aborted;
  },
  'ticker.forever': async function* (_input, ctx) {
    ctx.signal.addEventListener('abort', () => cancelled.resolve(String((ctx.signal.reason as Error)?.message)));
    for (let i = 0; ; i++) {
      yield i;
      await sleep(5);
    }
  },
  'idle.then.one': async function* () {
    await sleep(120);
    yield 'done';
  },
  'echo.duplex': async function* (inputs: AsyncIterable<unknown>) {
    for await (const value of inputs) yield { echo: value };
  },
  'sum.client': async (inputs: AsyncIterable<number>) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
};

let server: { url: string; close(): Promise<void> };

before(async () => {
  server = await startServer(handlers, { commitAfterMs: 20, heartbeatMs: 30 });
});
after(() => server.close());

for (const name of ['fetch', 'http2'] as const) {
  describe(`over ${name} transport`, () => {
    let client: ApueClient;
    before(() => {
      client = new ApueClient(new Map(transports(server.url)).get(name)!);
    });
    after(() => client.close());

    test('unary call over HTTP/2', async () => {
      assert.equal(await client.call('math.add', { a: 2, b: 40 }), 42);
      assert.deepEqual(await client.call('meta.version'), { httpVersion: '2.0' });
    });

    test('unknown operation → 404 problem', async () => {
      await assert.rejects(client.call('nope'), (e: ApueError) => e.status === 404 && e.problem.title === 'Unknown Operation');
    });

    test('server stream delivers all items then END', async () => {
      assert.deepEqual(await Array.fromAsync(client.stream('count.up', { to: 1000 })), Array.from({ length: 1000 }, (_, i) => i + 1));
    });

    test('mid-stream failure arrives in-band after earlier items', async () => {
      const seen: unknown[] = [];
      await assert.rejects(
        async () => {
          for await (const n of client.stream('count.failAt', { at: 4 })) seen.push(n);
        },
        (e: ApueError) => e.status === 409 && e.problem.detail === 'failed at 4',
      );
      assert.deepEqual(seen, [1, 2, 3]);
    });

    test('failure before the first item → real HTTP status', async () => {
      await assert.rejects(Array.fromAsync(client.stream('fail.early')), (e: ApueError) => e.status === 403);
    });

    test('deadline → 504 and handler sees aborted signal', async () => {
      const started = performance.now();
      await assert.rejects(client.call('slow.unary', undefined, { timeoutMs: 100 }), (e: ApueError) => e.status === 504);
      assert.ok(performance.now() - started < 1_000);
    });

    test('breaking out of a stream cancels it on the server', async () => {
      cancelled = Promise.withResolvers();
      for await (const n of client.stream<number>('ticker.forever')) if (n === 3) break;
      assert.equal(await cancelled.promise, 'Client Closed Request');
    });

    test('client streaming', async () => {
      async function* numbers() {
        for (let i = 1; i <= 100; i++) yield i;
      }
      assert.deepEqual(await Array.fromAsync(client.duplex('sum.client', numbers())), [5050]);
    });
  });
}

describe('full duplex (T1)', () => {
  test('node:http2 transport gets each echo before sending the next input', async () => {
    const client = new ApueClient(new Map(transports(server.url)).get('http2')!);
    const echoed = Promise.withResolvers<void>();
    let lastEcho = -1;
    async function* inputs() {
      for (let i = 0; i < 5; i++) {
        yield i;
        // Wait for the echo of `i` — only possible when the response streams while the request is open.
        while (lastEcho < i) await sleep(1);
      }
      echoed.resolve();
    }
    const out: unknown[] = [];
    for await (const item of client.duplex<{ echo: number }>('echo.duplex', inputs())) {
      lastEcho = item.echo;
      out.push(item);
    }
    await echoed.promise;
    assert.deepEqual(out, [0, 1, 2, 3, 4].map((echo) => ({ echo })));
    await client.close();
  });
});

describe('wire behaviour', () => {
  test('stream headers are committed before a slow first item (commitAfterMs)', async () => {
    const started = performance.now();
    const res = await fetch(`${server.url}/slow.first`, { method: 'POST', headers: { accept: MediaType.STREAM_JSON } });
    const headersAt = performance.now() - started;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('incremental'), '?1');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(headersAt < 250, `headers after ${headersAt.toFixed(0)} ms`);
    await res.body?.cancel();
  });

  test('heartbeats are sent while the stream is idle', async () => {
    const res = await fetch(`${server.url}/idle.then.one`, { method: 'POST', headers: { accept: MediaType.STREAM_JSON } });
    const types: number[] = [];
    for await (const frame of decodeFrames(res.body!)) types.push(frame.type);
    assert.ok(types.filter((t) => t === FrameType.HEARTBEAT).length >= 2, `frames: ${types}`);
    assert.deepEqual(types.filter((t) => t !== FrameType.HEARTBEAT), [FrameType.MSG, FrameType.END]);
  });

  test('SSE rendering of the same stream for debugging', async () => {
    const res = await fetch(`${server.url}/count.up`, {
      method: 'POST',
      headers: { accept: MediaType.SSE, 'content-type': MediaType.JSON },
      body: JSON.stringify({ to: 2 }),
    });
    assert.equal(res.headers.get('content-type'), MediaType.SSE);
    assert.equal(await res.text(), 'event: msg\ndata: 1\n\nevent: msg\ndata: 2\n\nevent: end\ndata: {"status":200}\n\n');
  });

  test('HTTP/1.1 fallback works for unary calls', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        `${server.url}/math.add`,
        { method: 'POST', ca: testCert().cert, headers: { 'content-type': MediaType.JSON } },
        (res) => {
          let text = `${res.httpVersion} ${res.statusCode} `;
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ a: 1, b: 2 }));
    });
    assert.equal(body, '1.1 200 3');
  });

  test('wrong method / media type → 405 / 415 problem+json', async () => {
    const get = await fetch(`${server.url}/math.add`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('content-type'), MediaType.PROBLEM);
    const xml = await fetch(`${server.url}/math.add`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: '<a/>' });
    assert.equal(xml.status, 415);
    assert.equal((await xml.json()).status, 415);
  });
});

describe('FrameWriter', () => {
  test('coalesces frames queued in the same tick into one write', async () => {
    const sink = new PassThrough();
    const writer = new FrameWriter(sink);
    for (let i = 0; i < 100; i++) void writer.msg(i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writer.writes, 1);
    sink.end();
    const frames = await Array.fromAsync(decodeFrames(sink));
    assert.deepEqual(frames.map((f) => decodeJson(f.payload)), Array.from({ length: 100 }, (_, i) => i));
  });

  test('flushes early once coalesceBytes is reached; 0 disables coalescing', async () => {
    const big = new FrameWriter(new PassThrough(), { coalesceBytes: 1024 });
    for (let i = 0; i < 100; i++) void big.msg('x'.repeat(100));
    assert.ok(big.writes >= 9 && big.writes <= 10, `writes: ${big.writes}`);
    const none = new FrameWriter(new PassThrough(), { coalesceBytes: 0 });
    for (let i = 0; i < 10; i++) void none.msg(i);
    assert.equal(none.writes, 10);
  });
});
