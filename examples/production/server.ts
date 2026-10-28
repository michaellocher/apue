// A production setup template (docs/deployment.md) — typechecked, not runnable as is: plug in your handlers and authentication.
// Environment: INSTANCE (e.g. eu-1), PORT, TLS_KEY / TLS_CERT (paths), RESUME_SECRET (≥ 16 bytes,
// the same on all replicas), UPLOAD_DIR (a directory of this replica), ALLOWED_ORIGINS (comma-separated).
import { readFileSync } from 'node:fs';
import { ApueError } from '../../src/protocol.ts';
import { createApueServer, type Handlers } from '../../src/server.ts';
import { MemoryIdempotencyStore, type IdempotencyStore } from '../../src/idempotency.ts';
import { todoApi } from '../todo/api.ts';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

// Replace with a store over shared storage (e.g. Redis) when you run more than one replica: the
// contract allows promises (src/idempotency.ts), so retries landing on another replica replay.
const idempotency: IdempotencyStore = new MemoryIdempotencyStore();

declare const handlers: Handlers<typeof todoApi>; // your handlers

const server = createApueServer(todoApi, handlers, {
  key: readFileSync(env('TLS_KEY')),
  cert: readFileSync(env('TLS_CERT')),
  instance: env('INSTANCE'), // routes uploads and downloads to this replica (docs/deployment/nginx.conf)
  resume: { secret: env('RESUME_SECRET') }, // resume tokens work on every replica
  idempotency,
  uploads: { directory: env('UPLOAD_DIR'), persistent: true, maxBytes: 256 * 1024 * 1024 },
  cors: { origins: env('ALLOWED_ORIGINS').split(','), credentials: true },
  // Who is calling: quotas and idempotency keys per user, not per proxy address or raw token.
  principal: ({ headers }) => {
    const token = headers.authorization;
    if (token === undefined) return undefined; // anonymous
    const user = verifyToken(String(token)); // your authentication
    if (!user) throw new ApueError(401, 'Unauthorized', 'invalid token', {}, { 'www-authenticate': 'Bearer' });
    return user;
  },
  shutdownGraceMs: 20_000, // below the orchestrator's grace period (Kubernetes: 30 s by default)
  logger: { error: (message, detail) => console.error(JSON.stringify({ level: 'error', message, detail: String(detail) })) },
  // Health check for the load balancer.
  fallback: (exchange) => {
    if (exchange.url !== '/healthz') return false;
    exchange.send(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, new TextEncoder().encode('ok'));
    return true;
  },
});

declare function verifyToken(token: string): string | undefined;

await server.listen(Number(env('PORT', '8443')), '0.0.0.0');
// Stop accepting, let calls finish (shutdownGraceMs), then exit.
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
