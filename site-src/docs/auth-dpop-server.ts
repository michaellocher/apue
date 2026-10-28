//-hide
import { readFileSync } from 'node:fs';
import { defineApi, op, t } from '../../src/index.ts';
import { createApueServer, type Handlers } from '../../src/server.ts';
const key = readFileSync('certs/key.pem');
const cert = readFileSync('certs/cert.pem');
const api = defineApi({ 'me.get': op({ effect: 'safe', input: t.void(), output: t.object({ user: t.string() }), cache: { private: true } }) });
const handlers: Handlers<typeof api> = { 'me.get': (_input, ctx) => ({ user: ctx.principal ?? 'anonymous' }) };
async function validateAccessToken(token: string | undefined): Promise<{ sub: string; cnf?: { jkt?: string } } | undefined> {
  return token ? { sub: 'u-1', cnf: { jkt: 'thumbprint' } } : undefined;
}
//-show
import { dpopError, dpopVerifier } from '../../src/server.ts';

// Checks each proof (RFC 9449 §4.3): signature, htm/htu, age, replay, ath.
// Behind a proxy, name the public origin clients sign for.
const dpop = dpopVerifier({ origin: 'https://api.example.com' });

const server = createApueServer(api, handlers, {
  key,
  cert,
  principal: async (request) => {
    const proof = await dpop(request); // 401 + WWW-Authenticate: DPoP … if not
    // Your token validation (JWT or introspection); then the binding:
    const token = await validateAccessToken(proof.accessToken);
    if (!token) throw dpopError('invalid_token', 'unknown or expired token');
    if (token.cnf?.jkt !== proof.jkt) throw dpopError('invalid_token', 'token not bound to this key');
    return token.sub;
  },
});
//-hide
export { server };
//-show
