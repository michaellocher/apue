// DPoP (RFC 9449): the server-side proof check for the `principal` hook (src/dpop.ts) and the
// WebCrypto proof signer for clients (src/dpop-signer.ts) — RFC test vectors, every check of §4.3,
// replays (also across replicas), nonces (§9), and end to end over HTTP/2, fetch and WebSocket.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signBytes, constants, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, fetchTransport } from '../src/client.ts';
import { createDpopSigner, dpopHeaders } from '../src/dpop-signer.ts';
import { dpopError, dpopVerifier, MemoryDpopReplayStore, thumbprint, type DpopOptions } from '../src/dpop.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { PrincipalRequest } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { webSocketTransport } from '../src/transport-ws.ts';
import { startServer, testCert } from './helpers.ts';

// RFC 9449 §4.1 (Figure 4) and §7.1 (Figure 13), verbatim; the key's thumbprint from §6.1.
const RFC_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg';
const RFC_RESOURCE_PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiJlMWozVl9iS2ljOC1MQUVCIiwiaHRtIjoiR0VUIiwiaHR1IjoiaHR0cHM6Ly9yZXNvdXJjZS5leGFtcGxlLm9yZy9wcm90ZWN0ZWRyZXNvdXJjZSIsImlhdCI6MTU2MjI2MjYxOCwiYXRoIjoiZlVIeU8ycjJaM0RaNTNFc05yV0JiMHhXWG9hTnk1OUlpS0NBcWtzbVFFbyJ9.2oW9RP35yRqzhrtNP86L-Ey71EOptxRimPPToA1plemAgR6pxHF8y6-yqyVnmcw6Fy1dqd-jfxSYoMxhAJpLjA';
const RFC_TOKEN = 'Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU';
const RFC_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';

const request = (method: string, url: string, headers: Record<string, string>): PrincipalRequest => ({ method, url, headers, remoteAddress: '127.0.0.1' });

/** Rejects with a 401 whose challenge names `error` (and, for a bad proof, says why). */
async function refused(promise: Promise<unknown>, error: string, because?: RegExp): Promise<ApueError> {
  try {
    await promise;
  } catch (thrown) {
    assert.ok(thrown instanceof ApueError, String(thrown));
    assert.equal(thrown.status, 401);
    assert.match(thrown.headers['www-authenticate']!, new RegExp(`^DPoP error="${error}"`));
    if (because) assert.match(thrown.problem.detail ?? '', because);
    return thrown;
  }
  assert.fail(`not refused (expected ${error}${because ? ` ${because}` : ''})`);
}

test('RFC 9449 examples verify; their key has the RFC thumbprint; RFC 7638 vector', async () => {
  const atIssue = (seconds: number) => () => seconds * 1000;
  const token = await dpopVerifier({ origin: 'https://server.example.com', now: atIssue(1562262616) })(request('POST', '/token', { dpop: RFC_PROOF }));
  assert.equal(token.jkt, RFC_JKT);
  assert.equal(token.accessToken, undefined);
  const resource = await dpopVerifier({ origin: 'https://resource.example.org', now: atIssue(1562262618) })(
    request('GET', '/protectedresource', { dpop: RFC_RESOURCE_PROOF, authorization: `DPoP ${RFC_TOKEN}` }),
  );
  assert.equal(resource.jkt, RFC_JKT);
  assert.equal(resource.accessToken, RFC_TOKEN);
  // The same proof with another token: ath doesn't match (§4.3 check 12).
  await refused(
    dpopVerifier({ origin: 'https://resource.example.org', now: atIssue(1562262618) })(request('GET', '/protectedresource', { dpop: RFC_RESOURCE_PROOF, authorization: `DPoP ${RFC_TOKEN}x` })),
    'invalid_dpop_proof',
    /ath/,
  );
  const rfc7638 = {
    kty: 'RSA',
    n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
    e: 'AQAB',
    alg: 'RS256',
    kid: '2011-04-29',
  };
  assert.equal(thumbprint(rfc7638), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
});

// Proofs made by hand, so that every part can be wrong on its own.
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
interface Key {
  alg: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}
function key(alg: 'ES256' | 'ES384' | 'EdDSA' | 'RS256' | 'PS256', bits = 2048): Key {
  const pair =
    alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : alg === 'ES384' ? generateKeyPairSync('ec', { namedCurve: 'P-384' })
    : alg === 'EdDSA' ? generateKeyPairSync('ed25519')
    : generateKeyPairSync('rsa', { modulusLength: bits });
  return { alg, privateKey: pair.privateKey, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown> };
}
function proof(k: Key, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const input = `${b64({ typ: 'dpop+jwt', alg: k.alg, jwk: k.jwk, ...header })}.${b64(claims)}`;
  const data = Buffer.from(input);
  const signature =
    k.alg === 'ES256' ? signBytes('sha256', data, { key: k.privateKey, dsaEncoding: 'ieee-p1363' })
    : k.alg === 'ES384' ? signBytes('sha384', data, { key: k.privateKey, dsaEncoding: 'ieee-p1363' })
    : k.alg === 'EdDSA' ? signBytes(null, data, k.privateKey)
    : k.alg === 'PS256' ? signBytes('sha256', data, { key: k.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST })
    : signBytes('sha256', data, k.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}
const NOW = 1_800_000_000;
const ORIGIN = 'https://api.example';
let jtis = 0;
const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ jti: `j-${++jtis}`, htm: 'POST', htu: `${ORIGIN}/orders.create`, iat: NOW, ...extra });
const verifier = (options: DpopOptions = {}) => dpopVerifier({ origin: ORIGIN, now: () => NOW * 1000, ...options });
const check = (dpop: string | string[] | undefined, extra: Record<string, string> = {}, options?: DpopOptions, method = 'POST', url = '/orders.create') =>
  verifier(options)({ method, url, headers: { ...(dpop === undefined ? {} : { dpop }), ...extra } as PrincipalRequest['headers'], remoteAddress: undefined });

test('accepted algorithms: ES256, ES384, EdDSA, PS256, RS256 (≥ 2048 bits); the thumbprint is the key\'s', async () => {
  for (const alg of ['ES256', 'ES384', 'EdDSA', 'PS256', 'RS256'] as const) {
    const k = key(alg);
    const result = await check(proof(k, claims()));
    assert.equal(result.jkt, thumbprint(k.jwk), alg);
    assert.deepEqual(Object.keys(result.jwk).sort(), Object.keys(k.jwk).sort(), `${alg}: the public key, nothing else`);
  }
  await refused(check(proof(key('RS256', 1024), claims())), 'invalid_dpop_proof', /2048/);
  // Only the configured ones.
  await refused(check(proof(key('ES384'), claims()), {}, { algorithms: ['ES256'] }), 'invalid_dpop_proof', /alg "ES384"/);
  assert.throws(() => dpopVerifier({ algorithms: ['HS256' as 'ES256'] }), /unsupported DPoP algorithm HS256/);
});

test('every check of RFC 9449 §4.3 refuses on its own', async () => {
  const k = key('ES256');
  const other = key('ES256');
  const ok = await check(proof(k, claims()));
  assert.equal(ok.claims.htm, 'POST');
  // 1–2: one well-formed compact JWS
  await refused(check([proof(k, claims()), proof(k, claims())]), 'invalid_dpop_proof', /more than one/);
  await refused(check(`${proof(k, claims())}, ${proof(k, claims())}`), 'invalid_dpop_proof', /compact JWS/);
  await refused(check('a.b'), 'invalid_dpop_proof', /compact JWS/);
  await refused(check('a.b.c=='), 'invalid_dpop_proof', /compact JWS/);
  await refused(check(`${b64([1])}.${b64({})}.AAAA`), 'invalid_dpop_proof', /JSON object/);
  await refused(check(proof(k, claims({ pad: 'x'.repeat(9000) }))), 'invalid_dpop_proof', /compact JWS/); // signed, but over 8 KiB
  // 3: required claims
  for (const missing of ['jti', 'htm', 'htu', 'iat']) {
    const { [missing]: _, ...rest } = claims();
    await refused(check(proof(k, rest)), 'invalid_dpop_proof', new RegExp(missing));
  }
  await refused(check(proof(k, claims({ jti: 'x'.repeat(257) }))), 'invalid_dpop_proof', /jti/);
  // 4: typ
  await refused(check(proof(k, claims(), { typ: 'JWT' })), 'invalid_dpop_proof', /typ/);
  // 5: alg — none, symmetric, or not fitting the key
  await refused(check(proof(k, claims(), { alg: 'none' })), 'invalid_dpop_proof', /alg "none"/);
  await refused(check(proof(k, claims(), { alg: 'HS256' })), 'invalid_dpop_proof', /alg "HS256"/);
  await refused(check(proof({ ...k, alg: 'ES256' }, claims(), { alg: 'ES384' })), 'invalid_dpop_proof', /does not fit ES384/);
  await refused(check(proof(k, claims(), { crit: ['exp'] })), 'invalid_dpop_proof', /crit/);
  // 6: the signature, by the key in the header
  await refused(check(proof({ ...k, jwk: other.jwk }, claims())), 'invalid_dpop_proof', /signature/);
  const valid = proof(k, claims());
  await refused(check(`${valid.slice(0, -4)}AAAA`), 'invalid_dpop_proof', /signature/);
  await refused(check(`${valid.slice(0, valid.lastIndexOf('.'))}.${'A'.repeat(90)}`), 'invalid_dpop_proof', /signature/);
  await refused(check(proof(k, claims(), { jwk: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' } })), 'invalid_dpop_proof', /valid public key/);
  await refused(check(proof(k, claims(), { jwk: undefined })), 'invalid_dpop_proof', /jwk is missing/);
  // 7: no private key
  const privateJwk = k.privateKey.export({ format: 'jwk' });
  await refused(check(proof(k, claims(), { jwk: privateJwk })), 'invalid_dpop_proof', /private key/);
  await refused(check(proof(k, claims(), { jwk: { kty: 'oct', k: 'c2VjcmV0' } })), 'invalid_dpop_proof', /private key/);
  // 8: htm
  await refused(check(proof(k, claims({ htm: 'GET' }))), 'invalid_dpop_proof', /htm/);
  await refused(check(proof(k, claims({ htm: 'post' }))), 'invalid_dpop_proof', /htm/);
  // 9: htu — the resource without query and fragment, after normalization
  for (const htu of [`${ORIGIN}/orders.create?x=1#f`, 'HTTPS://API.EXAMPLE:443/orders.create', `${ORIGIN}/a/../orders.create`]) {
    await check(proof(k, claims({ htu })));
  }
  await check(proof(k, claims()), {}, {}, 'POST', '/orders.create?i=%7B%7D'); // the request's query doesn't count either
  for (const htu of [`${ORIGIN}/orders.list`, 'https://evil.example/orders.create', 'http://api.example/orders.create', `${ORIGIN}:8443/orders.create`, 'not a url', 'urn:x:y']) {
    await refused(check(proof(k, claims({ htu }))), 'invalid_dpop_proof', /htu/);
  }
  // 11: iat within the window (default 60 s back, 5 s ahead)
  await check(proof(k, claims({ iat: NOW - 60 })));
  await refused(check(proof(k, claims({ iat: NOW - 61 }))), 'invalid_dpop_proof', /too old/);
  await check(proof(k, claims({ iat: NOW + 5 })));
  await refused(check(proof(k, claims({ iat: NOW + 6 }))), 'invalid_dpop_proof', /future/);
  await refused(check(proof(k, claims({ iat: String(NOW) }))), 'invalid_dpop_proof', /iat/);
  // 12: with an access token (Authorization: DPoP), ath is its hash
  const token = 'tok.en-1';
  const ath = createHash('sha256').update(token).digest('base64url');
  assert.equal((await check(proof(k, claims({ ath })), { authorization: `DPoP ${token}` })).accessToken, token);
  await refused(check(proof(k, claims()), { authorization: `DPoP ${token}` }), 'invalid_dpop_proof', /ath/);
  await refused(check(proof(k, claims({ ath: `${ath}x` })), { authorization: `DPoP ${token}` }), 'invalid_dpop_proof', /ath/);
  // A Bearer token is not the proof's business (its binding is the application's check).
  assert.equal((await check(proof(k, claims()), { authorization: `Bearer ${token}` })).accessToken, undefined);
});

test('no proof: 401 with a DPoP challenge naming the algorithms; challenges for the application', async () => {
  const missing = await check(undefined).then(() => assert.fail('accepted'), (error: ApueError) => error);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers['www-authenticate'], 'DPoP algs="ES256 ES384 EdDSA Ed25519 PS256 RS256"');
  const binding = dpopError('invalid_token', 'not bound to "this" key');
  assert.equal(binding.headers['www-authenticate'], 'DPoP error="invalid_token", error_description="not bound to this key"');
  assert.equal(binding.problem.error, 'invalid_token');
});

test('replays: refused within the window, also across replicas sharing a store; expired entries are dropped', async () => {
  const k = key('ES256');
  const once = proof(k, claims());
  const v = verifier();
  await v(request('POST', '/orders.create', { dpop: once }));
  await refused(v(request('POST', '/orders.create', { dpop: once })), 'invalid_dpop_proof', /already used/);
  // Two replicas: one shared store.
  let now = NOW * 1000;
  const shared = new MemoryDpopReplayStore(() => now);
  const [a, b] = [verifier({ replay: shared, now: () => now }), verifier({ replay: shared, now: () => now })];
  const proofForBoth = proof(k, claims());
  await a(request('POST', '/orders.create', { dpop: proofForBoth }));
  await refused(b(request('POST', '/orders.create', { dpop: proofForBoth })), 'invalid_dpop_proof', /already used/);
  // A proof that fails another check is not recorded: it can't block a valid one with the same jti.
  const jti = 'shared-jti';
  await refused(a(request('POST', '/orders.create', { dpop: proof(k, claims({ jti, htm: 'GET' })) })), 'invalid_dpop_proof', /htm/);
  await a(request('POST', '/orders.create', { dpop: proof(k, claims({ jti })) }));
  // The same jti from another key is another proof.
  await a(request('POST', '/orders.create', { dpop: proof(key('ES256'), claims({ jti })) }));
  // Entries live as long as their proofs are acceptable.
  const store = new MemoryDpopReplayStore(() => now);
  assert.equal(store.add('k', now + 1000), true);
  assert.equal(store.add('k', now + 1000), false);
  now += 1000;
  assert.equal(store.add('k', now + 1000), true, 'expired: may be recorded again (the proof is too old by then anyway)');
  // Between sweeps (once a second) too.
  assert.equal(store.add('short', now + 300), true);
  now += 300;
  assert.equal(store.add('short', now + 300), true, 'expired before the next sweep');
});

test('nonces (§9): without a valid one, 401 use_dpop_nonce with a fresh DPoP-Nonce; with it, accepted', async () => {
  const k = key('ES256');
  const issued = new Set<string>();
  let counter = 0;
  const nonces = { issue: () => { const n = `n-${++counter}`; issued.add(n); return n; }, check: (n: string) => issued.has(n) };
  const v = verifier({ nonces });
  const first = await refused(v(request('POST', '/orders.create', { dpop: proof(k, claims()) })), 'use_dpop_nonce');
  assert.equal(first.headers['dpop-nonce'], 'n-1');
  assert.equal(first.problem['dpop-nonce'], 'n-1', 'also in the problem: WebSocket clients can read it');
  await v(request('POST', '/orders.create', { dpop: proof(k, claims({ nonce: 'n-1' })) }));
  await refused(v(request('POST', '/orders.create', { dpop: proof(k, claims({ nonce: 'made-up' })) })), 'use_dpop_nonce');
  await refused(v(request('POST', '/orders.create', { dpop: proof(k, claims({ nonce: 'bad"nonce' })) })), 'use_dpop_nonce');
  // An invalid proof is invalid_dpop_proof first, whatever its nonce.
  await refused(v(request('POST', '/orders.create', { dpop: proof(k, claims({ nonce: 'n-1', htm: 'GET' })) })), 'invalid_dpop_proof');
  await assert.rejects(verifier({ nonces: { issue: () => 'has space', check: () => false } })(request('POST', '/orders.create', { dpop: proof(k, claims()) })), /visible ASCII/);
});

test('the request\'s own origin (:scheme/:authority, or Host) unless configured; a proxy needs `origin`', async () => {
  const k = key('ES256');
  const own = dpopVerifier({ now: () => NOW * 1000 });
  const htu = 'https://api.example/orders.create';
  await own({ method: 'POST', url: '/orders.create', headers: { ':scheme': 'https', ':authority': 'api.example', dpop: proof(k, claims({ htu })) }, remoteAddress: undefined });
  await own({ method: 'POST', url: '/orders.create', headers: { host: 'api.example', dpop: proof(k, claims({ htu })) }, remoteAddress: undefined });
  await refused(own({ method: 'POST', url: '/orders.create', headers: { host: 'internal:8443', dpop: proof(k, claims({ htu })) }, remoteAddress: undefined }), 'invalid_dpop_proof', /htu/);
  await assert.rejects(own({ method: 'POST', url: '/orders.create', headers: { dpop: proof(k, claims({ htu })) }, remoteAddress: undefined }), /no authority/);
});

const api = defineApi({
  'who.am': op({ effect: 'safe', input: t.void(), output: t.nullable(t.string()) }),
  'sum.up': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.object({ sum: t.number(), principal: t.nullable(t.string()) }) }),
});

test('end to end: signer → principal hook → handler, over HTTP/2, fetch and WebSocket; refusals reach the client', async (ctx) => {
  const dpop = dpopVerifier();
  const tokens = new Map<string, { sub: string; jkt: string }>(); // the "authorization server"
  const server = await startServer(api, {
    'who.am': (_, call) => call.principal ?? null,
    'sum.up': async (inputs, call) => {
      let sum = 0;
      for await (const n of inputs) sum += n;
      return { sum, principal: call.principal ?? null };
    },
  }, {
    principal: async (req) => {
      const checked = await dpop(req);
      const token = checked.accessToken === undefined ? undefined : tokens.get(checked.accessToken);
      if (!token) throw dpopError('invalid_token', 'unknown token');
      if (token.jkt !== checked.jkt) throw dpopError('invalid_token', 'the token is bound to another key');
      return token.sub;
    },
  });
  for (const alg of ['ES256', 'ES384', 'EdDSA'] as const) {
    const keyPair = alg === 'EdDSA'
      ? ((await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair)
      : ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: alg === 'ES256' ? 'P-256' : 'P-384' }, false, ['sign', 'verify'])) as CryptoKeyPair);
    const signer = await createDpopSigner(keyPair);
    assert.equal(signer.alg, alg);
    const token = `token-${alg}`;
    tokens.set(token, { sub: `user-${alg}`, jkt: signer.jkt });
    const options = { authorization: `DPoP ${token}`, headers: dpopHeaders(signer, server.url, () => token) };
    for (const [name, transport] of [
      ['http2', http2Transport(server.url, { ca: testCert().cert })],
      ['fetch', fetchTransport(server.url)],
      ['websocket', webSocketTransport(server.url)],
    ] as const) {
      const client = new ApueClient(api, transport, options);
      ctx.after(() => client.close());
      assert.equal(await client.call('who.am'), `user-${alg}`, `${alg} over ${name}`);
      assert.deepEqual(await Array.fromAsync(client.duplex('sum.up', (async function* () { yield 1; yield 2; })())), [{ sum: 3, principal: `user-${alg}` }], `${alg} client stream over ${name}`);
    }
  }
  // Default key: ES256, generated.
  assert.equal((await createDpopSigner()).alg, 'ES256');
  // A token bound to another key, and no proof: refused, with the challenge the client can read.
  const thief = await createDpopSigner();
  const stolen = new ApueClient(api, http2Transport(server.url, { ca: testCert().cert }), { authorization: 'DPoP token-ES256', headers: dpopHeaders(thief, server.url, () => 'token-ES256') });
  ctx.after(() => stolen.close());
  await assert.rejects(stolen.call('who.am'), (error: ApueError) => error.status === 401 && /another key/.test(error.problem.detail ?? ''));
  const res = await fetch(`${server.url}/who.am`, { headers: { authorization: 'DPoP token-ES256' } });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /^DPoP algs="/);
  await res.arrayBuffer();
  ctx.after(() => server.close());
});

test('end to end with nonces: the 401 carries one (also over WebSocket), the signer uses it on the retry', async (ctx) => {
  const issued = new Set<string>();
  let counter = 0;
  const dpop = dpopVerifier({ nonces: { issue: () => { const n = `nonce-${++counter}`; issued.add(n); return n; }, check: (n) => issued.has(n) } });
  const server = await startServer(api, {
    'who.am': (_, call) => call.principal ?? null,
    'sum.up': async (inputs) => {
      let sum = 0;
      for await (const n of inputs) sum += n;
      return { sum, principal: null };
    },
  }, { principal: async (req) => (await dpop(req)).jkt });
  ctx.after(() => server.close());
  for (const [name, transport] of [['http2', http2Transport(server.url, { ca: testCert().cert })], ['websocket', webSocketTransport(server.url)]] as const) {
    const signer = await createDpopSigner();
    const client = new ApueClient(api, transport, { headers: dpopHeaders(signer, server.url) });
    ctx.after(() => client.close());
    const challenge = await client.call('who.am').then(() => assert.fail('accepted without a nonce'), (error: ApueError) => error);
    assert.equal(challenge.status, 401, name);
    assert.match(String(challenge.problem['dpop-nonce']), /^nonce-\d+$/, `${name}: the nonce in the problem`);
    signer.nonce = String(challenge.problem['dpop-nonce']);
    assert.equal(await client.call('who.am'), signer.jkt, `${name}: accepted with the nonce`);
  }
});
