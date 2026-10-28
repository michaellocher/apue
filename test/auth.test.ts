// Who is calling (SPEC-DRAFT §5 "Callers"): the server's `principal` hook scopes idempotency keys,
// uploads and resume tokens; over WebSocket (T3) credentials travel as an `apue.auth.` subprotocol;
// cross-origin handshakes lose ambient credentials unless CORS allows them (cross-site WebSocket
// hijacking). Research: research/10.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { canonicalJson, defineApi, op } from '../src/api.ts';
import { ApueClient, type ClientOptions } from '../src/client.ts';
import { decodeFrames, FrameType } from '../src/frame.ts';
import { ApueError, MediaType, parseWsAuthProtocol, WS_AUTH_PREFIX, wsAuthProtocol } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { type ApueServerOptions, type CallContext, type Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { webSocketTransport } from '../src/transport-ws.ts';
import { checkHandshake } from '../src/websocket.ts';
import { startServer, testCert } from './helpers.ts';

const Seen = t.object({ principal: t.nullable(t.string()), authorization: t.nullable(t.string()), cookie: t.nullable(t.string()), protocols: t.nullable(t.string()) });
const api = defineApi({
  'who.am': op({ effect: 'safe', input: t.void(), output: Seen }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'files.size': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.number() }),
  'events.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ n: t.number() }), output: t.number() }),
  'who.streaming': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: Seen }),
});
const seen = (ctx: CallContext) => ({
  principal: ctx.principal ?? null,
  authorization: (ctx.headers.authorization as string | undefined) ?? null,
  cookie: (ctx.headers.cookie as string | undefined) ?? null,
  protocols: (ctx.headers['sec-websocket-protocol'] as string | undefined) ?? null,
});
let executions = 0;
const handlers: Handlers<typeof api> = {
  'who.am': (_, ctx) => seen(ctx),
  'orders.create': () => ++executions,
  'files.size': ({ data }) => data.byteLength,
  'events.watch': async function* ({ n }, ctx) {
    for (let i = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1; i < n; i++) {
      yield i;
      ctx.checkpoint(String(i));
    }
  },
  'who.streaming': async (inputs, ctx) => {
    for await (const _ of inputs);
    return seen(ctx);
  },
};

/** Tokens "Bearer <user>-<generation>": a refresh changes the token, never the user. */
const users: ApueServerOptions['principal'] = ({ headers }) => {
  const token = headers.authorization;
  if (token === undefined) return undefined;
  const match = /^Bearer ([a-z]+)-\d+$/.exec(String(token));
  if (!match) throw new ApueError(401, 'Unauthorized', 'unknown token', {}, { 'www-authenticate': 'Bearer' });
  return match[1];
};
const opened: ApueClient<typeof api>[] = [];
const client = (url: string, authorization?: ClientOptions['authorization']) => {
  const c = new ApueClient(api, http2Transport(url, { ca: testCert().cert }), authorization === undefined ? {} : { authorization });
  opened.push(c);
  return c;
};
after(async () => {
  for (const c of opened) await c.close();
});

describe('the principal hook', () => {
  let server: { url: string; close(): Promise<void> };
  let calls = 0;
  before(async () => {
    server = await startServer(api, handlers, {
      principal: (request) => {
        calls++;
        return users!(request);
      },
      uploads: { maxBytes: 1024 * 1024, scopeBytes: 1024 * 1024 },
    });
  });
  after(() => server.close());

  test('handlers get ctx.principal; anonymous callers none; one hook call per request, none for the manifest', async () => {
    const alice = client(server.url, 'Bearer alice-1');
    calls = 0;
    assert.deepEqual(await alice.call('who.am'), { principal: 'alice', authorization: 'Bearer alice-1', cookie: null, protocols: null });
    assert.equal(calls, 1);
    await fetch(`${server.url}/.well-known/apue`).then((r) => r.arrayBuffer());
    assert.equal(calls, 1);
    assert.equal((await client(server.url).call('who.am')).principal, null);
    await alice.close();
  });

  test('an ApueError from the hook is the response (401 with its headers), on calls, batches and uploads', async () => {
    const res = await fetch(`${server.url}/who.am`, { headers: { authorization: 'Basic nope' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    const intruder = client(server.url, 'Basic nope');
    const batch = intruder.batch();
    batch.call('who.am');
    await assert.rejects(batch.send(), (e: ApueError) => e.status === 401);
    await assert.rejects(intruder.upload(new Uint8Array(10)), (e: ApueError) => e.status === 401);
  });

  test('a function for credentials is asked per request (a refreshed token is used at once)', async () => {
    let generation = 1;
    const alice = client(server.url, () => `Bearer alice-${generation}`);
    assert.equal((await alice.call('who.am')).authorization, 'Bearer alice-1');
    generation = 2;
    assert.equal((await alice.call('who.am')).authorization, 'Bearer alice-2');
    await alice.close();
  });

  test('Idempotency-Key scope is the principal: a refreshed token replays, another user executes anew', async () => {
    const key = (authorization: string) => ({ 'content-type': MediaType.JSON, 'idempotency-key': '"k-auth"', authorization });
    const body = JSON.stringify({ item: 'a' });
    const first = await (await fetch(`${server.url}/orders.create`, { method: 'POST', headers: key('Bearer alice-1'), body })).json();
    const refreshed = await fetch(`${server.url}/orders.create`, { method: 'POST', headers: key('Bearer alice-2'), body });
    assert.equal(await refreshed.json(), first);
    assert.equal(refreshed.headers.get('apue-replayed'), '?1');
    const bob = await (await fetch(`${server.url}/orders.create`, { method: 'POST', headers: key('Bearer bob-1'), body })).json();
    assert.equal(bob, first + 1);
  });

  test('uploads belong to the principal: usable after a token refresh, invisible to others', async () => {
    const ref = await client(server.url, 'Bearer alice-1').upload(new Uint8Array(100));
    assert.equal(await client(server.url, 'Bearer alice-2').call('files.size', { data: ref }), 100);
    await assert.rejects(client(server.url, 'Bearer bob-1').call('files.size', { data: ref }), (e: ApueError) => e.status === 400);
  });

  test('upload quota per principal: two users behind one address each get their own', async () => {
    const alice = client(server.url, 'Bearer alice-7');
    const bob = client(server.url, 'Bearer bob-7');
    const refs = [await alice.upload(new Uint8Array(900 * 1024))];
    await assert.rejects(alice.upload(new Uint8Array(200 * 1024)), (e: ApueError) => e.status === 507); // alice's quota is full …
    refs.push(await bob.upload(new Uint8Array(900 * 1024))); // … bob's (same address) is not
    await alice.deleteUpload(refs[0]!);
    await bob.deleteUpload(refs[1]!);
    await alice.close();
    await bob.close();
  });

  test('resume tokens are bound to the principal: refresh resumes, another user is refused', async () => {
    const watch = (token: string, authorization: string) =>
      fetch(`${server.url}/events.watch?i=${encodeURIComponent(canonicalJson({ n: 5 }))}`, { headers: { accept: MediaType.STREAM_JSON, authorization, ...(token ? { 'apue-resume': token } : {}) } });
    const res = await watch('', 'Bearer alice-1');
    let checkpoint = '';
    for await (const frame of decodeFrames(res.body!)) {
      if (frame.type === FrameType.CHECKPOINT) {
        checkpoint = new TextDecoder().decode(frame.payload);
        await res.body!.cancel().catch(() => {});
        break;
      }
    }
    assert.ok(checkpoint);
    const resumed = await watch(checkpoint, 'Bearer alice-2');
    assert.equal(resumed.status, 200);
    await resumed.body!.cancel();
    const stolen = await watch(checkpoint, 'Bearer bob-1');
    assert.equal(stolen.status, 400);
    assert.equal((await stolen.json()).type, 'https://apue.dev/problems/invalid-resume-token');
  });

  test('batch lanes see the principal', async () => {
    const alice = client(server.url, 'Bearer alice-3');
    const batch = alice.batch();
    const who = batch.call('who.am');
    await batch.send();
    assert.equal((await who.result).principal, 'alice');
    await alice.close();
  });
});

describe('principal hook edge cases', () => {
  test('an async hook works; a broken one is a 500, not a silent anonymous call', async (ctx) => {
    ctx.mock.method(console, 'error', () => {});
    for (const [principal, status, expected] of [
      [async () => 'carol', 200, 'carol'],
      [() => 42 as unknown as string, 500, undefined],
      [() => '', 500, undefined],
      [() => {
        throw new Error('db down');
      }, 500, undefined],
      [async () => {
        throw new Error('db down');
      }, 500, undefined],
    ] as const) {
      const server = await startServer(api, handlers, { principal, uploads: {} });
      try {
        const res = await fetch(`${server.url}/who.am`);
        assert.equal(res.status, status, String(principal));
        if (expected) assert.equal((await res.json()).principal, expected);
        else await res.arrayBuffer();
      } finally {
        await server.close();
      }
    }
  });

  test('without a hook: scopes are the raw credentials (a refreshed token is another scope), uploads count per address', async (ctx) => {
    const server = await startServer(api, handlers, { uploads: { maxBytes: 1024 * 1024, scopeBytes: 1024 * 1024 } });
    ctx.after(() => server.close());
    const key = (authorization: string) => ({ 'content-type': MediaType.JSON, 'idempotency-key': '"k-raw"', authorization });
    const body = JSON.stringify({ item: 'a' });
    const first = await (await fetch(`${server.url}/orders.create`, { method: 'POST', headers: key('Bearer alice-1'), body })).json();
    assert.equal(await (await fetch(`${server.url}/orders.create`, { method: 'POST', headers: key('Bearer alice-2'), body })).json(), first + 1);
    const alice = client(server.url, 'Bearer alice-1');
    await alice.upload(new Uint8Array(900 * 1024));
    // a made-up Authorization buys no fresh quota
    await assert.rejects(client(server.url, 'Bearer made-up-1').upload(new Uint8Array(200 * 1024)), (e: ApueError) => e.status === 507);
    assert.equal((await client(server.url, 'Bearer x-1').call('who.am')).principal, null);
  });
});

describe('credentials over WebSocket (tier T3)', () => {
  /** Node's WebSocket accepts handshake headers (browsers don't): stands in for what a browser sends. */
  const browserLike = (headers: Record<string, string>) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, { protocols, headers } as never);
      }
    };
  const streamed = async (url: string, options: { authorization?: string; headers?: Record<string, string> }) => {
    const transport = webSocketTransport(url, { ...(options.headers ? { WebSocketImpl: browserLike(options.headers) } : {}) });
    const c = new ApueClient(api, transport, options.authorization === undefined ? {} : { authorization: options.authorization });
    try {
      const [result] = await Array.fromAsync(c.duplex('who.streaming', (async function* () {
        yield 1;
      })()));
      return result!;
    } finally {
      await c.close();
    }
  };
  let server: { url: string; close(): Promise<void> };
  before(async () => {
    server = await startServer(api, handlers, { principal: users, uploads: {} });
  });
  after(() => server.close());

  test('the token arrives as `authorization`, the principal is resolved, the carrying subprotocol is hidden', async () => {
    assert.deepEqual(await streamed(server.url, { authorization: 'Bearer alice-1' }), { principal: 'alice', authorization: 'Bearer alice-1', cookie: null, protocols: 'apue.v1' });
    assert.deepEqual(await streamed(server.url, {}), { principal: null, authorization: null, cookie: null, protocols: 'apue.v1' });
  });

  test('a token the hook rejects ends the call with its 401', async () => {
    await assert.rejects(streamed(server.url, { authorization: 'Basic nope' }), (e: ApueError) => e.status === 401);
  });

  test('a token that can\'t travel is refused before connecting', async () => {
    await assert.rejects(streamed(server.url, { authorization: 'Bearer é' }), TypeError);
  });

  test('handshake rules: one credential subprotocol at most, well-formed, not next to an Authorization header', () => {
    const base = { 'sec-websocket-version': '13' };
    const offer = (...protocols: string[]) => ({ ...base, 'sec-websocket-protocol': protocols.join(', ') });
    const any = () => true;
    const token = wsAuthProtocol('Bearer alice-1');
    assert.deepEqual(checkHandshake(offer('apue.v1', token), any), { ok: true, status: 200, authorization: 'Bearer alice-1', protocols: ['apue.v1'] });
    assert.equal(checkHandshake(offer('apue.v1', token, wsAuthProtocol('Bearer bob-1')), any).status, 400);
    assert.equal(checkHandshake({ ...offer('apue.v1', token), authorization: 'Bearer bob-1' }, any).status, 400);
    for (const bad of [`${WS_AUTH_PREFIX}`, `${WS_AUTH_PREFIX}QmVh=`, `${WS_AUTH_PREFIX}Q`, `${WS_AUTH_PREFIX}QR`, wsAuthProtocol('a\r\nb'), wsAuthProtocol(' lead'), wsAuthProtocol('trail ')]) {
      assert.equal(checkHandshake(offer('apue.v1', bad), any).status, 400, bad);
      assert.equal(parseWsAuthProtocol(bad), undefined, bad);
    }
    assert.equal(checkHandshake(offer(token), any).status, 400); // credentials alone are not apue.v1
  });

  test('a malformed credential subprotocol fails the handshake (the handler never runs)', async () => {
    const ws = new WebSocket(`${server.url.replace('https', 'wss')}/who.streaming`, ['apue.v1', `${WS_AUTH_PREFIX}QR`]);
    const outcome = await new Promise((resolve) => {
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('refused');
    });
    assert.equal(outcome, 'refused');
  });
});

describe('cross-site WebSocket hijacking: ambient credentials on cross-origin handshakes', () => {
  const ambient = { cookie: 'sid=s3cret', authorization: 'Basic Y2FjaGVkOmJhc2lj' };
  const call = async (url: string, headers: Record<string, string>) => {
    const transport = webSocketTransport(url, {
      WebSocketImpl: class extends WebSocket {
        constructor(u: string | URL, protocols?: string | string[]) {
          super(u, { protocols, headers } as never);
        }
      },
    });
    const c = new ApueClient(api, transport);
    try {
      const [result] = await Array.fromAsync(c.duplex('who.streaming', (async function* () {
        yield 1;
      })()));
      return result!;
    } finally {
      await c.close();
    }
  };

  test("cors '*': a cross-origin handshake loses cookies and cached credentials; same-origin keeps them", async (ctx) => {
    const server = await startServer(api, handlers, { cors: { origins: '*' }, uploads: {} });
    ctx.after(() => server.close());
    const own = `https://${new URL(server.url).host}`;
    const cross = await call(server.url, { origin: 'https://evil.example', ...ambient });
    assert.equal(cross.cookie, null);
    assert.equal(cross.authorization, null);
    const same = await call(server.url, { origin: own, ...ambient });
    assert.equal(same.cookie, 'sid=s3cret');
    assert.equal(same.authorization, ambient.authorization);
    const tool = await call(server.url, ambient); // no Origin: not a browser
    assert.equal(tool.cookie, 'sid=s3cret');
  });

  test('an origin list keeps them only with credentials: true (as CORS does for fetch)', async () => {
    for (const credentials of [false, true]) {
      const server = await startServer(api, handlers, { cors: { origins: ['https://app.example'], credentials }, uploads: {} });
      try {
        const seen = await call(server.url, { origin: 'https://app.example', ...ambient });
        assert.equal(seen.cookie, credentials ? 'sid=s3cret' : null, `credentials: ${credentials}`);
      } finally {
        await server.close();
      }
    }
  });

  test('explicit credentials (subprotocol) still work cross-origin without CORS credentials', async (ctx) => {
    const server = await startServer(api, handlers, { cors: { origins: '*' }, principal: users, uploads: {} });
    ctx.after(() => server.close());
    const transport = webSocketTransport(server.url, {
      WebSocketImpl: class extends WebSocket {
        constructor(u: string | URL, protocols?: string | string[]) {
          super(u, { protocols, headers: { origin: 'https://evil.example', cookie: 'sid=s3cret' } } as never);
        }
      },
    });
    const c = new ApueClient(api, transport, { authorization: 'Bearer alice-1' });
    ctx.after(() => c.close());
    const [seen] = await Array.fromAsync(c.duplex('who.streaming', (async function* () {
      yield 1;
    })()));
    assert.deepEqual(seen, { principal: 'alice', authorization: 'Bearer alice-1', cookie: null, protocols: 'apue.v1' });
  });
});
