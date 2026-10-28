// Runs inside a real browser (served type-stripped). Returns one result per check.
import { ApueClient, fetchTransport } from '../../src/client.ts';
import { ApueError } from '../../src/protocol.ts';
import { browserApi } from './api.ts';

export interface CheckResult {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

export async function run(apiUrl: string): Promise<CheckResult[]> {
  const client = new ApueClient(browserApi, fetchTransport(apiUrl));
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      if (error instanceof Skip) results.push({ name, ok: true, skipped: true, detail: error.message });
      else results.push({ name, ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  };

  await check('unary GET (safe op)', async () => {
    equal(await client.call('users.get', { id: '7' }), { id: '7', name: 'user 7' });
  });
  await check('connection is HTTP/2 (Resource Timing nextHopProtocol)', async () => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const api = entries.filter((e) => e.name.startsWith(apiUrl));
    if (api.length === 0) throw new Error('no resource timing entries for the API');
    const protocols = [...new Set(api.map((e) => e.nextHopProtocol))];
    if (!protocols.every((p) => p === 'h2')) throw new Error(`protocols: ${protocols.join(', ')}`);
    return protocols.join(',');
  });
  await check('QUERY for a large read (cross-origin, preflighted)', async () => {
    const tags = Array.from({ length: 300 }, (_, i) => `tag-${i}`);
    equal(await client.call('users.search', { q: 'x', tags }), { q: 'x', count: 300 });
  });
  await check('unsafe POST with Idempotency-Key (custom header, preflighted)', async () => {
    const { orderId } = await client.call('orders.create', { item: 'book' });
    if (typeof orderId !== 'number') throw new Error('no order id');
  });
  await check('server stream', async () => {
    equal(await Array.fromAsync(client.stream('count.up', { to: 100 })), Array.from({ length: 100 }, (_, i) => i + 1));
  });
  await check('breaking out of a stream cancels it on the server', async () => {
    const before = await client.call('stats.cancelled');
    for await (const n of client.stream('ticker')) if (n === 3) break;
    for (let i = 0; i < 50; i++) {
      if ((await client.call('stats.cancelled')) > before) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('server did not observe the cancellation');
  });
  await check('pipelined batch with references', async () => {
    const batch = client.batch();
    const user = batch.call('users.get', { id: '9' });
    const again = batch.call('users.get', { id: user.ref('id') });
    await batch.send();
    equal(await again.result, { id: '9', name: 'user 9' });
  });
  await check('problem details: unknown op 404, validation 400', async () => {
    await rejects(client.call('users.get', { id: 5 as unknown as string }), 400);
    const res = await fetch(`${apiUrl}/nope.nothing`);
    if (res.status !== 404 || (await res.json()).type !== 'https://apue.dev/problems/unknown-operation') throw new Error(`status ${res.status}`);
  });
  await check('deadline → 504', async () => {
    await rejects(client.call('slow.get', undefined, { timeoutMs: 100 }), 504);
  });
  await check('compressed response is decoded by the browser', async () => {
    const res = await fetch(`${apiUrl}/big.get`);
    const encoding = res.headers.get('content-encoding');
    const text = await res.json();
    if (text.length !== 8192) throw new Error('wrong body');
    if (!encoding) throw new Error('response was not compressed');
    return `content-encoding: ${encoding}`;
  });
  await check('client streaming upload (tier T2: fetch duplex half)', async () => {
    if (!supportsRequestStreams()) throw new Skip('request streams not supported by this browser');
    async function* numbers() {
      for (let i = 1; i <= 100; i++) yield i;
    }
    equal(await Array.fromAsync(client.duplex('sum.client', numbers())), [5050]);
  });
  return results;
}

class Skip extends Error {}

// Feature detection from https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests
function supportsRequestStreams(): boolean {
  let duplexAccessed = false;
  const hasContentType = new Request('https://example.invalid', {
    body: new ReadableStream(),
    method: 'POST',
    get duplex() {
      duplexAccessed = true;
      return 'half';
    },
  } as RequestInit).headers.has('Content-Type');
  return duplexAccessed && !hasContentType;
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function rejects(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApueError && error.status === status) return;
    throw new Error(`expected ApueError ${status}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`expected rejection with ${status}`);
}
