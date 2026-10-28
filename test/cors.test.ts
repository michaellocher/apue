// CORS: preflight answers, allowed vs disallowed origins, exposed headers, Vary merging.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { after, before, describe, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { startServer, testCert } from './helpers.ts';

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'big.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
});
const handlers: Handlers<typeof api> = { 'users.get': () => 'u', 'big.get': () => 'x'.repeat(4096) };
const ORIGIN = 'https://app.example';

let listed: { url: string; close(): Promise<void> };
let anyOrigin: { url: string; close(): Promise<void> };
let noCors: { url: string; close(): Promise<void> };
before(async () => {
  listed = await startServer(api, handlers, { cors: { origins: [ORIGIN], credentials: true } });
  anyOrigin = await startServer(api, handlers, { cors: { origins: '*', maxAge: 600 } });
  noCors = await startServer(api, handlers);
});
after(async () => {
  await Promise.all([listed.close(), anyOrigin.close(), noCors.close()]);
});

function request(url: string, headers: Record<string, string>): Promise<http2.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(url, { ca: testCert().cert });
    const req = session.request(headers);
    let response: http2.IncomingHttpHeaders = {};
    req.on('response', (h) => (response = h));
    req.on('data', () => {});
    req.on('end', () => {
      session.close();
      resolve(response);
    });
    req.on('error', reject);
    req.end();
  });
}

const preflight = (url: string, origin: string, requestHeaders = 'content-type, idempotency-key, x-evil') =>
  request(url, {
    ':method': 'OPTIONS',
    ':path': '/users.get',
    origin,
    'access-control-request-method': 'QUERY',
    'access-control-request-headers': requestHeaders,
  });

describe('CORS', () => {
  test('preflight from an allowed origin: 204, methods, filtered headers, max-age', async () => {
    const h = await preflight(listed.url, ORIGIN);
    assert.equal(h[':status'], 204);
    assert.equal(h['access-control-allow-origin'], ORIGIN);
    assert.equal(h['access-control-allow-credentials'], 'true');
    assert.equal(h['access-control-allow-methods'], 'DELETE, GET, HEAD, PATCH, POST, QUERY');
    assert.equal(h['access-control-allow-headers'], 'content-type, idempotency-key');
    assert.equal(h['access-control-max-age'], '7200');
    assert.equal(h.vary, 'origin');
  });

  test('preflight allows resuming streams: apue-resume and last-event-id (review finding)', async () => {
    const h = await preflight(listed.url, ORIGIN, 'apue-resume, last-event-id, apue-timeout');
    assert.equal(h[':status'], 204);
    assert.equal(h['access-control-allow-headers'], 'apue-resume, last-event-id, apue-timeout');
  });

  test('preflight from another origin → 403 without CORS headers', async () => {
    const h = await preflight(listed.url, 'https://evil.example');
    assert.equal(h[':status'], 403);
    assert.equal(h['access-control-allow-origin'], undefined);
  });

  test('actual requests: allow-origin, exposed headers, Timing-Allow-Origin, Vary combined', async () => {
    const h = await request(listed.url, { ':path': '/big.get', origin: ORIGIN, 'accept-encoding': 'zstd' });
    assert.equal(h[':status'], 200);
    assert.equal(h['access-control-allow-origin'], ORIGIN);
    assert.match(String(h['access-control-expose-headers']), /etag/);
    assert.match(String(h['access-control-expose-headers']), /apue-replayed/);
    assert.equal(h['timing-allow-origin'], ORIGIN);
    assert.equal(h.vary, 'origin, accept-encoding');
    assert.equal(h['content-encoding'], 'zstd');
  });

  test('disallowed origins are served without CORS headers (the browser blocks them)', async () => {
    const h = await request(listed.url, { ':path': '/users.get', origin: 'https://evil.example' });
    assert.equal(h[':status'], 200);
    assert.equal(h['access-control-allow-origin'], undefined);
    assert.equal(h.vary, 'origin');
  });

  test('responses without Origin still say Vary: origin, so caches cannot cross-serve them (review finding)', async () => {
    const h = await request(listed.url, { ':path': '/users.get' });
    assert.equal(h[':status'], 200);
    assert.equal(h['access-control-allow-origin'], undefined);
    assert.equal(h.vary, 'origin');
  });

  test("origins: '*' → wildcard, no Vary: origin, custom max-age", async () => {
    const h = await preflight(anyOrigin.url, 'https://whoever.example', 'apue-timeout');
    assert.equal(h['access-control-allow-origin'], '*');
    assert.equal(h['access-control-max-age'], '600');
    assert.equal(h['access-control-allow-headers'], 'apue-timeout');
    assert.equal(h.vary, undefined);
  });

  test('without cors, OPTIONS is just a disallowed method', async () => {
    const h = await preflight(noCors.url, ORIGIN);
    assert.equal(h[':status'], 405);
    assert.equal(h['access-control-allow-origin'], undefined);
  });

  test('credentials with a wildcard origin are refused at startup', () => {
    const { key, cert } = testCert();
    assert.throws(() => createApueServer(api, handlers, { key, cert, cors: { origins: '*', credentials: true } }), /explicit origin list/);
  });
});
