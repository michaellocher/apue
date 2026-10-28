//-hide
import { readFileSync } from 'node:fs';
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';
import { createApueServer, type Handlers, type Exchange } from '../../src/server.ts';
const api = defineApi({ 'ping.get': op({ effect: 'safe', input: t.void(), output: t.string() }) });
const handlers: Handlers<typeof api> = { 'ping.get': () => 'pong' };
const page = new TextEncoder().encode('<!doctype html><title>app</title>');
//-show
const server = createApueServer(api, handlers, {
  // TLS is required (HTTP/2 with HTTP/1.1 fallback)
  key: readFileSync('certs/key.pem'),
  cert: readFileSync('certs/cert.pem'),
  maxBodyBytes: 1024 * 1024,   // 413 above this (default 1 MiB)
  shutdownGraceMs: 10_000,     // close(): calls in flight get this long, then 503
  resume: { secret: process.env.APUE_RESUME_SECRET! }, // the same on every replica
  compression: { codings: ['zstd', 'br', 'gzip'], minBytes: 1024 },
  // Serve the web app from the same origin: no CORS, no preflights.
  fallback: (exchange: Exchange) => {
    if (exchange.url !== '/') return false;
    exchange.send(200, { 'content-type': 'text/html; charset=utf-8' }, page);
    return true;
  },
});
const port = await server.listen(8443, '0.0.0.0');
process.on('SIGTERM', () => void server.close());
//-hide
console.log(port);
//-show
