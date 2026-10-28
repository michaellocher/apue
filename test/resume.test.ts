// Resumable streams: signed checkpoints, transparent client resume, replicas without sticky sessions.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { canonicalJson, defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport, type TransportRequest } from '../src/client.ts';
import { decodeFrames, decodeJson, encodeFrame, FrameType } from '../src/frame.ts';
import { ApueError, MediaType } from '../src/protocol.ts';
import { ResumeTokens } from '../src/resume.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { sleep, startServer, testCert } from './helpers.ts';
import { hash } from 'node:crypto';

const api = defineApi({
  'events.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ n: t.number() }), output: t.number() }),
  'events.failing': op({ effect: 'safe', stream: 'server', resumable: true, input: t.void(), output: t.number() }),
  'plain.stream': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'events.sparse': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ n: t.number() }), output: t.number() }),
});

const resumedFrom: Array<string | undefined> = [];
const handlers: Handlers<typeof api> = {
  'events.watch': async function* ({ n }, ctx) {
    resumedFrom.push(ctx.resumeFrom);
    const start = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1;
    for (let i = start; i < n; i++) {
      yield i;
      ctx.checkpoint(String(i)); // everything up to i has been delivered
    }
  },
  'events.failing': async function* (_input, ctx) {
    yield 1;
    ctx.checkpoint('1');
    throw new ApueError(409, 'Conflict', 'stream failed on purpose');
  },
  'events.sparse': async function* ({ n }, ctx) {
    for (let i = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1; i < n; i++) {
      yield i;
      if (i % 5 === 4) ctx.checkpoint(String(i)); // several items between checkpoints
    }
  },
  'plain.stream': async function* (_input, ctx) {
    yield 1;
    ctx.checkpoint('x'); // not resumable: must fail loudly
  },
};

const SECRET = 'a shared replica secret, 32 bytes!!';
let a: { url: string; close(): Promise<void> };
let b: { url: string; close(): Promise<void> };
let other: { url: string; close(): Promise<void> };
before(async () => {
  a = await startServer(api, handlers, { resume: { secret: SECRET } });
  b = await startServer(api, handlers, { resume: { secret: SECRET } });
  other = await startServer(api, handlers, { resume: { secret: 'another secret entirely, 32 bytes' } });
});
after(() => Promise.all([a.close(), b.close(), other.close()]));

/** Cuts the response body after `cutAfter` bytes for the first `failures` requests (simulated network loss). */
function flaky(inner: Transport, cutAfter: number, failures: number) {
  const log: TransportRequest[] = [];
  let remaining = failures;
  const transport: Transport = {
    async request(req) {
      log.push(req);
      const res = await inner.request(req);
      if (remaining-- <= 0) return res;
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
  return { transport, log };
}

/** Cuts attempt k right after `msgsPerAttempt[k]` MSG frames (frame-exact, unlike `flaky`). */
function cutAfterMessages(inner: Transport, msgsPerAttempt: number[]): Transport {
  let attempt = 0;
  return {
    async request(req) {
      const res = await inner.request(req);
      const limit = msgsPerAttempt[attempt++];
      if (limit === undefined) return res;
      return {
        ...res,
        body: (async function* () {
          let msgs = 0;
          for await (const frame of decodeFrames(res.body)) {
            yield encodeFrame(frame.type, frame.payload, frame.lane, frame.flags);
            if (frame.type === FrameType.MSG && ++msgs === limit) throw new Error('ECONNRESET (simulated)');
          }
        })(),
      };
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
}

describe('resume tokens', () => {
  test('issue/verify; tampering, other call, expiry and secrets are rejected', () => {
    let now = 1_000_000;
    const tokens = new ResumeTokens({ secret: SECRET, ttlMs: 1000, now: () => now });
    const token = tokens.issue('events.watch', 'h1', '41');
    assert.equal(tokens.verify(token, 'events.watch', 'h1'), '41');
    const invalid = (fn: () => unknown, detail: RegExp) => assert.throws(fn, (e: ApueError) => e.status === 400 && detail.test(e.problem.detail ?? ''));
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), c: '0' })).toString('base64url');
    invalid(() => tokens.verify(`${forged}.${signature}`, 'events.watch', 'h1'), /signature/);
    invalid(() => tokens.verify(token, 'events.watch', 'h2'), /different call/);
    invalid(() => tokens.verify(token, 'other.op', 'h1'), /different call/);
    invalid(() => tokens.verify('garbage', 'events.watch', 'h1'), /malformed/);
    invalid(() => new ResumeTokens({ secret: 'another secret entirely, 32 bytes' }).verify(token, 'events.watch', 'h1'), /signature/);
    now += 2000;
    invalid(() => tokens.verify(token, 'events.watch', 'h1'), /expired/);
    assert.throws(() => new ResumeTokens({ secret: 'short' }), /at least 16 bytes/);
  });

  test('op() only allows resumable on safe/idempotent server streams', () => {
    assert.throws(() => op({ effect: 'safe', resumable: true, input: t.void(), output: t.void() }), /server-streaming/);
    assert.throws(() => op({ effect: 'unsafe', stream: 'server', resumable: true, input: t.void(), output: t.void() }), /safe or idempotent/);
  });
});

describe('transparent resume', () => {
  test('two connection losses mid-stream: every item exactly once, in order', async () => {
    resumedFrom.length = 0;
    const { transport, log } = flaky(http2Transport(a.url, { ca: testCert().cert, acceptEncoding: '' }), 700, 2);
    const client = new ApueClient(api, transport, { backoffMs: 5 });
    const items = await Array.fromAsync(client.stream('events.watch', { n: 60 }));
    assert.deepEqual(items, Array.from({ length: 60 }, (_, i) => i));
    assert.equal(log.length, 3);
    assert.equal(log[0]!.headers['apue-resume'], undefined);
    assert.ok(log[1]!.headers['apue-resume'] && log[2]!.headers['apue-resume']);
    assert.equal(resumedFrom[0], undefined);
    assert.ok(Number(resumedFrom[1]) >= 0 && Number(resumedFrom[2]) > Number(resumedFrom[1]));
    await client.close();
  });

  test('exactly once wherever the connection drops (30 cut positions, 2 losses each)', async () => {
    for (let cut = 160; cut < 160 + 30 * 97; cut += 97) {
      const { transport } = flaky(http2Transport(a.url, { ca: testCert().cert, acceptEncoding: '' }), cut, 2);
      const client = new ApueClient(api, transport, { backoffMs: 1 });
      const items = await Array.fromAsync(client.stream('events.watch', { n: 40 }));
      assert.deepEqual(items, Array.from({ length: 40 }, (_, i) => i), `cut after ${cut} bytes`);
      await client.close();
    }
  });

  test('a second loss during the replay still skips everything already seen (review finding)', async () => {
    // Attempt 1: items 0-4, checkpoint 4, items 5-7, loss. Attempt 2 replays from 5: one item
    // (5, skipped), loss. Attempt 3 must still skip 5-7, not only 5.
    const transport = cutAfterMessages(http2Transport(a.url, { ca: testCert().cert, acceptEncoding: '' }), [8, 1]);
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    assert.deepEqual(await Array.fromAsync(client.stream('events.sparse', { n: 12 })), Array.from({ length: 12 }, (_, i) => i));
    await client.close();
  });

  test('resume budget: gives up after `resumes` attempts', async () => {
    const { transport, log } = flaky(http2Transport(a.url, { ca: testCert().cert, acceptEncoding: '' }), 700, 100);
    const client = new ApueClient(api, transport, { backoffMs: 1 });
    await assert.rejects(Array.fromAsync(client.stream('events.watch', { n: 1000 }, { resumes: 2 })), /ECONNRESET/);
    assert.equal(log.length, 3);
    await client.close();
  });

  test('no checkpoint before the loss → no resume; server-side errors are never resumed', async () => {
    const early = flaky(http2Transport(a.url, { ca: testCert().cert, acceptEncoding: '' }), 3, 1);
    await assert.rejects(Array.fromAsync(new ApueClient(api, early.transport).stream('events.watch', { n: 5 })), /ECONNRESET/);
    assert.equal(early.log.length, 1);
    const failing = flaky(http2Transport(a.url, { ca: testCert().cert }), 1_000_000, 0);
    await assert.rejects(Array.fromAsync(new ApueClient(api, failing.transport).stream('events.failing')), (e: ApueError) => e.status === 409);
    assert.equal(failing.log.length, 1);
  });

  test('ctx.checkpoint() on a non-resumable op fails loudly', async (t) => {
    t.mock.method(console, 'error', () => {});
    const client = new ApueClient(api, http2Transport(a.url, { ca: testCert().cert }));
    await assert.rejects(Array.fromAsync(client.stream('plain.stream')), (e: ApueError) => e.status === 500);
    await client.close();
  });
});

describe('stateless across replicas', () => {
  async function firstCheckpoint(url: string, n: number): Promise<string> {
    const res = await fetch(`${url}/events.watch?i=${encodeURIComponent(canonicalJson({ n }))}`, { headers: { accept: MediaType.STREAM_JSON } });
    for await (const frame of decodeFrames(res.body!)) {
      if (frame.type === FrameType.CHECKPOINT) {
        await res.body!.cancel().catch(() => {});
        return new TextDecoder().decode(frame.payload);
      }
    }
    throw new Error('no checkpoint');
  }

  async function itemsWith(url: string, token: string, n: number, header = 'apue-resume') {
    const res = await fetch(`${url}/events.watch?i=${encodeURIComponent(canonicalJson({ n }))}`, { headers: { accept: MediaType.STREAM_JSON, [header]: token } });
    if (res.status !== 200) return { status: res.status, items: [] as unknown[] };
    const items: unknown[] = [];
    for await (const frame of decodeFrames(res.body!)) if (frame.type === FrameType.MSG) items.push(decodeJson(frame.payload));
    return { status: 200, items };
  }

  test('a token issued by replica A resumes on replica B (shared secret)', async () => {
    const token = await firstCheckpoint(a.url, 5); // cursor "0"
    assert.deepEqual(await itemsWith(b.url, token, 5), { status: 200, items: [1, 2, 3, 4] });
  });

  test('replica with another secret, or another input → 400 before the stream starts', async () => {
    const token = await firstCheckpoint(a.url, 5);
    assert.equal((await itemsWith(other.url, token, 5)).status, 400);
    assert.equal((await itemsWith(a.url, token, 6)).status, 400);
  });

  test('SSE: checkpoints become `id:` lines and Last-Event-ID resumes', async () => {
    const res = await fetch(`${a.url}/events.watch?i=${encodeURIComponent(canonicalJson({ n: 2 }))}`, { headers: { accept: MediaType.SSE } });
    const text = await res.text();
    const ids = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]!);
    assert.equal(ids.length, 2);
    assert.deepEqual(await itemsWith(a.url, ids[0]!, 2, 'last-event-id'), { status: 200, items: [1] });
  });
});

void sleep;
void hash;
