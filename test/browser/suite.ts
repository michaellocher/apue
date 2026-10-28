// Runs inside a real browser (served type-stripped). Returns one result per check.
import { ApueClient, fetchTransport } from '../../src/client.ts';
import { ApueError } from '../../src/protocol.ts';
import { autoTransport, probeRequestStreams, supportsRequestStreams, webSocketTransport } from '../../src/transport-ws.ts';
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
  await check('a long server stream over fetch (> 1 MiB: beyond every flow-control window)', async () => {
    // 60,000 items ≈ 1.3 MiB of frames. Reports how far it got if the stream stalls.
    let received = 0;
    const stalled = new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 20_000));
    const read = (async () => {
      for await (const n of client.stream('count.up', { to: 60_000 })) received = n;
      return 'done';
    })();
    const outcome = await Promise.race([read, stalled]);
    if (outcome !== 'done' || received !== 60_000) throw new Error(`stream ${outcome} after ${received} of 60000 items`);
    return '60000 items';
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
    if (!(await probeRequestStreams(apiUrl))) throw new Skip(supportsRequestStreams() ? 'the browser claims request streams but cannot send them (autoTransport uses WebSocket)' : 'request streams not supported by this browser');
    async function* numbers() {
      for (let i = 1; i <= 100; i++) yield i;
    }
    equal(await Array.fromAsync(client.duplex('sum.client', numbers())), [5050]);
  });
  await check('full duplex over WebSocket (tier T3), cross-origin', async () => {
    const ws = new ApueClient(browserApi, webSocketTransport(apiUrl));
    let lastEcho = 0;
    async function* inputs() {
      for (let i = 1; i <= 5; i++) {
        yield i;
        // Only possible with true full duplex: wait for the echo before sending more.
        while (lastEcho < i) await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    const out: number[] = [];
    for await (const { echo } of ws.duplex('echo.duplex', inputs())) {
      lastEcho = echo;
      out.push(echo);
    }
    equal(out, [1, 2, 3, 4, 5]);
    // fetch would revalidate a cached GET; cache: private + no-cache keeps this fresh.
    return `server saw the WebSocket over ${await client.call('stats.lastDuplexVersion')}`;
  });
  await check('credentials on every tier: Authorization over fetch, apue.auth. subprotocol over WebSocket (S21)', async () => {
    const authed = new ApueClient(browserApi, webSocketTransport(apiUrl), { authorization: 'Bearer browser-user' });
    equal(await authed.call('who.am'), { principal: 'browser-user', authorization: 'Bearer browser-user', protocols: null }); // fetch, preflighted
    async function* one() {
      yield 1;
    }
    // The server selected only apue.v1 (the transport checks ws.protocol) and hid the token.
    equal(await Array.fromAsync(authed.duplex('who.streaming', one())), [{ principal: 'browser-user', authorization: 'Bearer browser-user', protocols: 'apue.v1' }]);
    await authed.close();
  });
  await check('WebSocket shares the h2 connection when fetch sends credentials (RFC 8441)', async () => {
    const credentialed = new ApueClient(browserApi, fetchTransport(apiUrl, { credentials: 'include' }));
    await credentialed.call('users.get', { id: 'warm-up' }); // h2 session with the WebSocket's key
    const ws = new ApueClient(browserApi, webSocketTransport(apiUrl));
    async function* one() {
      yield 1;
    }
    await Array.fromAsync(ws.duplex('echo.duplex', one()));
    const version = await credentialed.call('stats.lastDuplexVersion');
    // A claim about Chrome (§8: it reuses the h2 session only with credentials) and Firefox (RFC 8441
    // always). WebKit varies by build — macOS used h2, Playwright's Linux build HTTP/1.1 (CI), and it
    // reports a Safari user agent everywhere — so for WebKit the result is reported, not asserted;
    // the server takes both.
    const chromeOrFirefox = /Chrome\/|Firefox\//.test(navigator.userAgent);
    if (version !== 'HTTP/2.0' && !chromeOrFirefox) throw new Skip(`this WebKit build opened the WebSocket over ${version}`);
    if (version !== 'HTTP/2.0') throw new Error(`WebSocket used ${version}, not the shared h2 connection`);
    return `server saw the WebSocket over ${version}`;
  });
  await check('WebSocket credit: a stalled consumer bounds what the server sends (apue.v1)', async () => {
    const ws = new ApueClient(browserApi, webSocketTransport(apiUrl, { receiveWindow: 1024 * 1024 }));
    let release!: () => void;
    async function* one() {
      yield 1;
      await new Promise<void>((resolve) => (release = resolve));
    }
    const items = ws.duplex('flood', one())[Symbol.asyncIterator]();
    await items.next();
    await new Promise((resolve) => setTimeout(resolve, 1000)); // the page doesn't consume
    const ahead = await client.call('stats.flooded');
    // 1 MiB window + 256 KiB server buffer + one 64 KiB item: ≈ 22 items (without credit: all 500)
    if (ahead > 30) throw new Error(`server got ${ahead} items (${ahead / 16} MiB) ahead`);
    let count = 1;
    while (!(await items.next()).done) count++;
    release();
    equal(count, 500);
    return `server stopped ${ahead} × 64 KiB ahead of the stalled page, then delivered all 500`;
  });
  await check('resumable upload: bytes in a unary input, cross-origin (PATCH + Upload-* through CORS)', async () => {
    const data = crypto.getRandomValues(new Uint8Array(65_536)).slice(); // getRandomValues: ≤ 64 KiB per call
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i += data.length) big.set(data, i);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', big))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const result = await client.call('files.store', { data: big });
    equal(result, { size: big.byteLength, sha256: digest });
    // The upload resource's state is readable cross-origin (exposed Upload-* headers).
    const ref = await client.upload(new Uint8Array(1000));
    const head = await fetch(`${apiUrl}/$uploads/${ref.$upload}`, { method: 'HEAD' });
    if (head.headers.get('upload-offset') !== '1000' || head.headers.get('upload-complete') !== '?1') {
      throw new Error(`offset retrieval: ${head.status} offset=${head.headers.get('upload-offset')} complete=${head.headers.get('upload-complete')}`);
    }
    return 'uploaded 1 MiB via careful creation + PATCH; HEAD shows Upload-Offset';
  });
  await check('t.file(): a Blob is uploaded as is and reaches the handler as a stream (S20)', async () => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 48; i++) parts.push(crypto.getRandomValues(new Uint8Array(65_536))); // 3 MiB
    const blob = new Blob(parts as BlobPart[]);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
    equal(await client.call('files.ingest', { file: blob }), { size: blob.size, sha256: digest, declared: digest });
    // Too large for t.file({ max }): refused on the client, before anything is uploaded.
    await rejects(client.call('files.ingest', { file: new Blob([new Uint8Array(9 * 1024 * 1024)]) }), 400);
    return `${blob.size} bytes, server digest = browser digest`;
  });
  await check('t.download(): a link-usable URL with Range through CORS; content verified, corruption refused', async () => {
    const { archive } = await client.call('export.archive', { corrupt: false });
    if (!archive.url.startsWith(apiUrl)) throw new Error(`url ${archive.url} is not absolute on ${apiUrl}`);
    const bytes = await archive.bytes(); // WebCrypto-verified
    if (bytes.byteLength !== 1024 * 1024 || bytes[7] !== 49) throw new Error('wrong content');
    // What a media element or a download manager does: a Range request (cross-origin here).
    const part = await fetch(archive.url, { headers: { range: 'bytes=100-199' } });
    equal([part.status, part.headers.get('content-range'), part.headers.get('accept-ranges'), (await part.arrayBuffer()).byteLength], [206, `bytes 100-199/${1024 * 1024}`, 'bytes', 100]);
    const { archive: corrupt } = await client.call('export.archive', { corrupt: true });
    await rejects(corrupt.bytes(), 502);
    return `1 MiB via ${archive.url.replace(apiUrl, '')}`;
  });
  await check('autoTransport: streaming upload in every browser (fetch T2 or WebSocket T3)', async () => {
    const auto = new ApueClient(browserApi, autoTransport(apiUrl));
    async function* numbers() {
      for (let i = 1; i <= 100; i++) yield i;
    }
    equal(await Array.fromAsync(auto.duplex('sum.client', numbers())), [5050]);
    return (await probeRequestStreams(apiUrl)) ? 'via fetch (T2)' : 'via WebSocket (T3)';
  });
  return results;
}

class Skip extends Error {}

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
