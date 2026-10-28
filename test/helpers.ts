import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fetchTransport, type Transport } from '../src/client.ts';
import { createApueServer, type ApueServerOptions, type Handler } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';

let cached: { key: string; cert: string } | undefined;

/** Throwaway self-signed cert for 127.0.0.1, trusted for this process (fetch included). */
export function testCert(): { key: string; cert: string } {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'apue-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  cached = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), cached.cert]);
  return cached;
}

export async function startServer(
  handlers: Record<string, Handler>,
  options: Partial<ApueServerOptions> = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const { key, cert } = testCert();
  const apue = createApueServer(handlers, { key, cert, ...options });
  const port = await apue.listen();
  return { url: `https://127.0.0.1:${port}`, close: () => apue.close() };
}

export function transports(url: string): Array<[name: string, transport: Transport]> {
  return [
    ['fetch', fetchTransport(url)],
    ['http2', http2Transport(url, { ca: testCert().cert })],
  ];
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
