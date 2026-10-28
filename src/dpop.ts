// DPoP (RFC 9449) proof verification for the `principal` hook: proof-of-possession for access
// tokens. apü defines no authentication; this checks the proof (§4.3) and hands the application
// the key's thumbprint, which its token validation compares with the token's `cnf.jkt` (§6.1).
import { createHash, createPublicKey, verify, constants, type KeyObject, type webcrypto } from 'node:crypto';
import { ApueError } from './protocol.ts';
import type { PrincipalRequest } from './server.ts';

type JsonWebKey = webcrypto.JsonWebKey;

export type DpopAlgorithm = 'ES256' | 'ES384' | 'ES512' | 'EdDSA' | 'Ed25519' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512';

export interface DpopOptions {
  /**
   * The public origin clients sign `htu` for (e.g. `https://api.example`). Default: the request's
   * own (`:scheme` and `:authority`, or `Host` over HTTP/1.1) — set it behind a proxy.
   */
  origin?: string;
  /** Accepted `alg` values (§4.3 check 5). Default: ES256, ES384, EdDSA/Ed25519, PS256, RS256. */
  algorithms?: readonly DpopAlgorithm[];
  /** How old a proof may be by its `iat`, in seconds (§11.1). Default 60. */
  maxAgeSeconds?: number;
  /** How far `iat` may lie in the future (clock skew), in seconds. Default 5. */
  clockSkewSeconds?: number;
  /**
   * Replay detection over `jti` (§11.1). Default: one in-process store per verifier. Replicas share
   * one (e.g. Redis `SET key 1 NX PXAT expiresAt`) so a proof can't be replayed on another instance.
   */
  replay?: DpopReplayStore;
  /**
   * Server-provided nonces (§9): a proof without a valid one is answered with 401
   * `use_dpop_nonce` and a fresh nonce in `DPoP-Nonce` (and the problem's `dpop-nonce` member, which
   * reaches WebSocket clients too). Nonces are visible ASCII without `"` and `\` (§8.1).
   */
  nonces?: { issue(): string | Promise<string>; check(nonce: string): boolean | Promise<boolean> };
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

export interface DpopReplayStore {
  /**
   * Records `key` until `expiresAt` (ms since the epoch); resolves false if it was already recorded —
   * a replay. Must be atomic across everything sharing the store.
   */
  add(key: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface DpopProof {
  /** JWK SHA-256 thumbprint of the proof's key (RFC 7638): compare with the token's `cnf.jkt`. */
  jkt: string;
  /** The proof's public key. */
  jwk: JsonWebKey;
  /** The access token from `Authorization: DPoP <token>` (its `ath` was checked), if any. */
  accessToken: string | undefined;
  /** The proof's claims (`jti`, `htm`, `htu`, `iat`, and `ath`/`nonce` when present). */
  claims: Readonly<Record<string, unknown>>;
}

/** Remembers `jti`s until their proofs expire. One process only: replicas need a shared store. */
export class MemoryDpopReplayStore implements DpopReplayStore {
  readonly #seen = new Map<string, number>();
  readonly #now: () => number;
  #swept = 0;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  add(key: string, expiresAt: number): boolean {
    const now = this.#now();
    if (now - this.#swept >= 1000) {
      this.#swept = now;
      for (const [k, until] of this.#seen) if (until <= now) this.#seen.delete(k);
    }
    const until = this.#seen.get(key);
    if (until !== undefined && until > now) return false;
    this.#seen.set(key, expiresAt);
    return true;
  }
}

const DEFAULT_ALGORITHMS: readonly DpopAlgorithm[] = ['ES256', 'ES384', 'EdDSA', 'Ed25519', 'PS256', 'RS256'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[\x21\x23-\x5B\x5D-\x7E]+$/; // NQCHAR (§8.1)
const MAX_PROOF = 8192; // characters; a proof with an RSA-4096 key is ~1.5 KB
const MAX_JTI = 256;
/** JWK members that only private (or symmetric) keys have (§4.3 check 7). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

interface Scheme {
  kty: 'EC' | 'OKP' | 'RSA';
  /** Hash for node:crypto's verify (null: Ed25519). */
  hash: string | null;
  curve?: string; // JWK crv (EC, OKP)
  pss?: boolean;
  /** ECDSA signature length (r ‖ s). */
  signatureBytes?: number;
}
const SCHEMES: Record<DpopAlgorithm, Scheme> = {
  ES256: { kty: 'EC', hash: 'sha256', curve: 'P-256', signatureBytes: 64 },
  ES384: { kty: 'EC', hash: 'sha384', curve: 'P-384', signatureBytes: 96 },
  ES512: { kty: 'EC', hash: 'sha512', curve: 'P-521', signatureBytes: 132 },
  EdDSA: { kty: 'OKP', hash: null, curve: 'Ed25519' },
  Ed25519: { kty: 'OKP', hash: null, curve: 'Ed25519' }, // RFC 9864's fully specified name
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
};
/** The members of each key type's public key, in RFC 7638 order (also what the key is built from). */
const PUBLIC_MEMBERS = { EC: ['crv', 'kty', 'x', 'y'], OKP: ['crv', 'kty', 'x'], RSA: ['e', 'kty', 'n'] } as const;

/**
 * A verifier for the `principal` hook: resolves with the checked proof, or rejects with 401 and a
 * `WWW-Authenticate: DPoP` challenge (RFC 9449 §7.1). It checks the proof only — the application
 * validates the access token and compares its `cnf.jkt` with `jkt` (§4.3 check 12, second part).
 *
 *   const dpop = dpopVerifier({ origin: 'https://api.example' });
 *   principal: async (request) => {
 *     const proof = await dpop(request);
 *     const token = await validateAccessToken(proof.accessToken); // the application's
 *     if (token.cnf?.jkt !== proof.jkt) throw dpopError('invalid_token', 'not bound to this key');
 *     return token.sub;
 *   }
 *
 * Over WebSocket (tier T3) the proof arrives as an `apue.dpop.` subprotocol and the call reports
 * POST with its op path — what the client signs on every tier.
 */
export function dpopVerifier(options: DpopOptions = {}): (request: PrincipalRequest) => Promise<DpopProof> {
  const algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;
  for (const alg of algorithms) if (!Object.hasOwn(SCHEMES, alg)) throw new TypeError(`unsupported DPoP algorithm ${alg}`);
  const algs = algorithms.join(' ');
  const maxAge = options.maxAgeSeconds ?? 60;
  const skew = options.clockSkewSeconds ?? 5;
  if (!(maxAge > 0) || !(skew >= 0)) throw new TypeError('maxAgeSeconds must be positive, clockSkewSeconds not negative');
  const now = options.now ?? Date.now;
  const replay = options.replay ?? new MemoryDpopReplayStore(now);
  const origin = options.origin === undefined ? undefined : new URL(options.origin).origin;
  const invalid = (description: string) => dpopError('invalid_dpop_proof', description, algs);

  return async (request) => {
    const header = request.headers.dpop;
    if (header === undefined) throw new ApueError(401, 'Unauthorized', 'a DPoP proof is required', {}, { 'www-authenticate': `DPoP algs="${algs}"` });
    // Check 1: more than one field arrives as an array, or joined with ", " (not a JWS character).
    if (typeof header !== 'string') throw invalid('more than one DPoP header field');
    // Check 2: one well-formed JWS in compact serialization.
    const parts = header.length <= MAX_PROOF ? header.split('.') : [];
    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) throw invalid('not a compact JWS');
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    const jose = decodeJson(encodedHeader);
    const claims = decodeJson(encodedClaims);
    if (!jose || !claims) throw invalid('header or claims are not a JSON object');

    // Checks 4, 5, 7 and the key.
    if (typeof jose.typ !== 'string' || jose.typ.toLowerCase() !== 'dpop+jwt') throw invalid('typ is not dpop+jwt');
    const alg = jose.alg;
    if (typeof alg !== 'string' || !algorithms.includes(alg as DpopAlgorithm)) throw invalid(`alg ${JSON.stringify(alg)} is not accepted`);
    if (jose.crit !== undefined) throw invalid('crit: no extensions are understood');
    const scheme = SCHEMES[alg as DpopAlgorithm];
    const jwk = jose.jwk;
    if (!isObject(jwk)) throw invalid('jwk is missing');
    if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(jwk, member))) throw invalid('jwk contains a private key');
    if (jwk.kty !== scheme.kty || (scheme.curve !== undefined && jwk.crv !== scheme.curve)) throw invalid(`jwk does not fit ${alg}`);
    const members = PUBLIC_MEMBERS[scheme.kty];
    if (!members.every((member) => typeof jwk[member] === 'string' && (member === 'kty' || member === 'crv' || BASE64URL.test(jwk[member] as string)))) {
      throw invalid('jwk is not a well-formed public key');
    }
    const publicJwk = Object.fromEntries(members.map((member) => [member, jwk[member] as string])) as JsonWebKey;
    let key: KeyObject;
    try {
      key = createPublicKey({ key: publicJwk, format: 'jwk' });
    } catch {
      throw invalid('jwk is not a valid public key');
    }
    if (scheme.kty === 'RSA' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw invalid('RSA keys need at least 2048 bits');

    // Check 6: the signature, with the key from the header.
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (scheme.signatureBytes !== undefined && signature.byteLength !== scheme.signatureBytes) throw invalid('bad signature');
    const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii');
    const verifyKey = scheme.kty === 'EC' ? { key, dsaEncoding: 'ieee-p1363' as const } : scheme.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key;
    let valid = false;
    try {
      valid = verify(scheme.hash, signed, verifyKey, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw invalid('bad signature');

    // Check 3 and 8–9: the claims, and what they bind.
    const { jti, htm, htu, iat } = claims;
    if (typeof jti !== 'string' || jti.length === 0 || jti.length > MAX_JTI) throw invalid('jti is missing');
    if (htm !== request.method) throw invalid('htm does not match the request method');
    if (typeof htu !== 'string' || !sameResource(htu, requestUrl(request, origin))) throw invalid('htu does not match the request URI');
    // Check 11: the creation time.
    if (typeof iat !== 'number' || !Number.isFinite(iat)) throw invalid('iat is missing');
    const seconds = now() / 1000;
    if (iat < seconds - maxAge) throw invalid('the proof is too old');
    if (iat > seconds + skew) throw invalid('the proof is from the future');
    // Check 12, first part: with an access token, ath is its hash.
    const accessToken = dpopToken(request.headers.authorization);
    if (accessToken !== undefined) {
      if (claims.ath !== createHash('sha256').update(accessToken, 'ascii').digest('base64url')) throw invalid('ath does not match the access token');
    }
    // Check 10: the nonce, if the server issues them.
    if (options.nonces) {
      const nonce = claims.nonce;
      if (typeof nonce !== 'string' || !NONCE.test(nonce) || !(await options.nonces.check(nonce))) {
        const fresh = await options.nonces.issue();
        if (!NONCE.test(fresh)) throw new TypeError('DPoP nonces must be visible ASCII without " and \\');
        throw dpopError('use_dpop_nonce', 'a fresh nonce is required', algs, fresh);
      }
    }
    // Replays (§11.1), recorded last: proofs that fail a check don't fill the store.
    const jkt = thumbprint(publicJwk);
    if (!(await replay.add(`${jkt}:${jti}`, Math.ceil((iat + maxAge) * 1000)))) throw invalid('the proof was already used');
    return { jkt, jwk: publicJwk, accessToken, claims };
  };
}

/**
 * A 401 with a `WWW-Authenticate: DPoP` challenge (RFC 9449 §7.1), e.g. `invalid_token` when the
 * access token is not bound to the proof's key. With a nonce: `DPoP-Nonce` and the problem's
 * `dpop-nonce` member.
 */
export function dpopError(error: 'invalid_dpop_proof' | 'use_dpop_nonce' | 'invalid_token' | 'invalid_request', description: string, algs?: string, nonce?: string): ApueError {
  const challenge = `DPoP error="${error}", error_description="${description.replace(/["\\]/g, '')}"${algs ? `, algs="${algs}"` : ''}`;
  return new ApueError(401, 'Unauthorized', description, { error, ...(nonce === undefined ? {} : { 'dpop-nonce': nonce }) }, {
    'www-authenticate': challenge,
    ...(nonce === undefined ? {} : { 'dpop-nonce': nonce }),
  });
}

/** JWK SHA-256 thumbprint (RFC 7638) of an EC, OKP or RSA public key. */
export function thumbprint(jwk: JsonWebKey): string {
  const members = PUBLIC_MEMBERS[jwk.kty as keyof typeof PUBLIC_MEMBERS];
  if (!members) throw new TypeError(`no thumbprint for kty ${String(jwk.kty)}`);
  const canonical = `{${members.map((member) => `${JSON.stringify(member)}:${JSON.stringify(jwk[member])}`).join(',')}}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

/** The access token of `Authorization: DPoP <token>` (RFC 9449 §7.1), else undefined. */
function dpopToken(authorization: string | undefined): string | undefined {
  const match = /^DPoP +([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization ?? '');
  return match?.[1];
}

/** The request's URI as the client addressed it. */
function requestUrl(request: PrincipalRequest, origin: string | undefined): URL {
  if (origin !== undefined) return new URL(request.url, origin);
  const authority = request.headers[':authority'] ?? request.headers.host;
  const scheme = request.headers[':scheme'] ?? 'https'; // apü serves TLS; HTTP/1.1 has no :scheme
  if (typeof authority !== 'string' || authority === '') throw new Error('DPoP: the request has no authority — set the verifier\'s origin');
  return new URL(request.url, `${scheme}://${authority}`);
}

/**
 * `htu` names the request's URI, ignoring query and fragment; compared after syntax- and
 * scheme-based normalization (RFC 3986 §6.2.2–6.2.3, as WHATWG URL parsing does: case of scheme and
 * host, default ports, dot segments, an empty path is "/").
 */
function sameResource(htu: string, target: URL): boolean {
  let claimed: URL;
  try {
    claimed = new URL(htu);
  } catch {
    return false;
  }
  const resource = (url: URL) => `${url.protocol}//${url.host}${url.pathname}`;
  return (claimed.protocol === 'https:' || claimed.protocol === 'http:') && resource(claimed) === resource(target);
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
