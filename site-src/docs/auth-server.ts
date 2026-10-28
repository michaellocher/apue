//-hide
import { readFileSync } from 'node:fs';
import { defineApi, op, t } from '../../src/index.ts';
import { createApueServer, type Handlers } from '../../src/server.ts';
const key = readFileSync('certs/key.pem');
const cert = readFileSync('certs/cert.pem');
const api = defineApi({ 'me.get': op({ effect: 'safe', input: t.void(), output: t.object({ user: t.string() }), cache: { private: true } }) });
async function verifyToken(token: string): Promise<{ sub: string } | undefined> {
  return token.length > 10 ? { sub: 'u-1' } : undefined;
}
//-show
import { ApueError } from '../../src/index.ts';

const handlers: Handlers<typeof api> = {
  'me.get': (_input, ctx) => ({ user: ctx.principal ?? 'anonymous' }),
};

const server = createApueServer(api, handlers, {
  key,
  cert,
  // Who is calling: a stable id (not the token, which changes on every
  // refresh), or undefined for anonymous callers.
  principal: async ({ headers, method, url }) => {
    const header = headers.authorization;
    if (header === undefined) return undefined; // anonymous
    const claims = await verifyToken(String(header).replace(/^Bearer /, ''));
    if (!claims) {
      const challenge = { 'www-authenticate': 'Bearer' };
      throw new ApueError(401, 'Unauthorized', 'invalid token', {}, challenge);
    }
    console.log(method, url); // e.g. to check a DPoP proof's htm/htu
    return claims.sub;
  },
  // Cross-origin browsers (same-origin needs none of this and saves the preflights):
  cors: { origins: ['https://app.example.com'], credentials: true, maxAge: 7200 },
});
//-hide
export { server };
//-show
