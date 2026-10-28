//-hide
// Mirrors examples/production/server.ts with package imports. Typechecked, not run.
import { defineApi, op, t } from '../../src/index.ts';
import type { ApueServerOptions } from '../../src/server.ts';
const api = defineApi({ 'ping.get': op({ effect: 'safe', input: t.void(), output: t.string() }) });
declare const handlers: Handlers<typeof api>;
declare function verifyToken(token: string): string | undefined;
/** A store over shared storage (e.g. Redis), implementing begin / complete / release. */
declare const sharedIdempotencyStore: Exclude<NonNullable<ApueServerOptions['idempotency']>, false>;
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};
//-show
import { readFileSync } from 'node:fs';
import { ApueError } from '../../src/index.ts';
import { createApueServer, type Handlers } from '../../src/server.ts';

const server = createApueServer(api, handlers, {
  key: readFileSync(env('TLS_KEY')),
  cert: readFileSync(env('TLS_CERT')),
  instance: env('INSTANCE'),                  // e.g. eu-1: routes uploads and downloads to this replica
  resume: { secret: env('RESUME_SECRET') },  // ≥ 16 bytes, the same on every replica
  idempotency: sharedIdempotencyStore,        // retries that reach another replica are replayed
  uploads: { directory: env('UPLOAD_DIR'), persistent: true },  // a directory per replica
  cors: { origins: env('ALLOWED_ORIGINS').split(','), credentials: true },
  // Who is calling: quotas and idempotency keys per user, not per proxy address or raw token.
  principal: ({ headers }) => {
    const token = headers.authorization;
    if (token === undefined) return undefined; // anonymous
    const user = verifyToken(String(token));   // your authentication
    if (!user) throw new ApueError(401, 'Unauthorized', 'invalid token', {}, { 'www-authenticate': 'Bearer' });
    return user;
  },
  shutdownGraceMs: 20_000, // below the orchestrator's grace period (Kubernetes: 30 s by default)
  logger: { error: (message, detail) => console.error(JSON.stringify({ level: 'error', message, detail: String(detail) })) },
  fallback: (exchange) => { // health check for the load balancer
    if (exchange.url !== '/healthz') return false;
    exchange.send(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, new TextEncoder().encode('ok'));
    return true;
  },
});

await server.listen(Number(env('PORT', '8443')), '0.0.0.0');
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
