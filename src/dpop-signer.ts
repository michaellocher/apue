// DPoP (RFC 9449) proofs for clients, with WebCrypto (browsers and Node): a fresh signed proof per
// request through the client's `headers` option — over WebSocket (tier T3) it travels as an
// `apue.dpop.` subprotocol. The server checks proofs with `dpopVerifier` (apue/server).
import type { ClientOptions } from './client.ts';

export interface DpopSigner {
  /** JWK SHA-256 thumbprint (RFC 7638) of the public key: what a DPoP-bound token's `cnf.jkt` names. */
  readonly jkt: string;
  readonly publicJwk: JsonWebKey;
  /** The JWS `alg` of the proofs (ES256, ES384 or EdDSA). */
  readonly alg: string;
  /**
   * Server-provided nonce (RFC 9449 §9) for the next proofs: after a 401 `use_dpop_nonce`, take it
   * from the problem's `dpop-nonce` member (`error.problem['dpop-nonce']`) and retry.
   */
  nonce: string | undefined;
  /** A fresh proof for one request; `url` is absolute (query and fragment are left out of `htu`). */
  proof(request: { method: string; url: string; accessToken?: string }): Promise<string>;
}

/**
 * A proof signer for `keyPair` — by default a new ECDSA P-256 pair whose private key can't be
 * exported (keep the pair, e.g. in IndexedDB, for as long as tokens are bound to it).
 */
export async function createDpopSigner(keyPair?: CryptoKeyPair): Promise<DpopSigner> {
  const subtle = globalThis.crypto.subtle;
  const keys = keyPair ?? ((await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair);
  const algorithm = keys.privateKey.algorithm as EcKeyAlgorithm;
  const { alg, sign } =
    algorithm.name === 'ECDSA' && algorithm.namedCurve === 'P-256'
      ? { alg: 'ES256', sign: { name: 'ECDSA', hash: 'SHA-256' } }
      : algorithm.name === 'ECDSA' && algorithm.namedCurve === 'P-384'
        ? { alg: 'ES384', sign: { name: 'ECDSA', hash: 'SHA-384' } }
        : algorithm.name === 'Ed25519'
          ? { alg: 'EdDSA', sign: { name: 'Ed25519' } }
          : (() => {
              throw new TypeError(`DPoP keys: ECDSA P-256 or P-384, or Ed25519 (not ${algorithm.name})`);
            })();
  const exported = await subtle.exportKey('jwk', keys.publicKey);
  const members = exported.kty === 'EC' ? (['crv', 'kty', 'x', 'y'] as const) : (['crv', 'kty', 'x'] as const);
  const publicJwk = Object.fromEntries(members.map((member) => [member, exported[member]])) as JsonWebKey;
  const canonical = `{${members.map((member) => `${JSON.stringify(member)}:${JSON.stringify(publicJwk[member])}`).join(',')}}`;
  const jkt = base64url(await subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  const header = encodeJson({ typ: 'dpop+jwt', alg, jwk: publicJwk });

  const signer: DpopSigner = {
    jkt,
    publicJwk,
    alg,
    nonce: undefined,
    async proof({ method, url, accessToken }) {
      const target = new URL(url);
      const claims: Record<string, unknown> = {
        jti: base64url(globalThis.crypto.getRandomValues(new Uint8Array(16))),
        htm: method,
        htu: `${target.origin}${target.pathname}`,
        iat: Math.floor(Date.now() / 1000),
      };
      if (accessToken !== undefined) claims.ath = base64url(await subtle.digest('SHA-256', new TextEncoder().encode(accessToken)));
      if (signer.nonce !== undefined) claims.nonce = signer.nonce;
      const input = `${header}.${encodeJson(claims)}`;
      return `${input}.${base64url(await subtle.sign(sign, keys.privateKey, new TextEncoder().encode(input)))}`;
    },
  };
  return signer;
}

/**
 * The client's `headers` option for DPoP: a fresh proof per request, for `origin` + the request's
 * path. `accessToken`, when given, binds each proof to the token (`ath`) — send that token as
 * `authorization: 'DPoP <token>'`.
 *
 *   const signer = await createDpopSigner();
 *   new ApueClient(api, transport, { authorization: () => `DPoP ${token}`, headers: dpopHeaders(signer, origin, () => token) });
 */
export function dpopHeaders(signer: DpopSigner, origin: string, accessToken?: () => string | undefined | Promise<string | undefined>): NonNullable<ClientOptions['headers']> {
  const base = new URL(origin).origin;
  return async ({ method, path }) => {
    const token = await accessToken?.();
    return { dpop: await signer.proof({ method, url: `${base}${path}`, ...(token === undefined ? {} : { accessToken: token }) }) };
  };
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
