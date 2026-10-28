// Verifies docs/deployment/nginx.conf end to end (needs Docker): two apü replicas (instances eu-1 and
// eu-2, a shared resume secret) behind the real nginx, routing by path prefix and the apue-replica
// header. Calls with automatic uploads, explicit uploads, downloads and resumed streams must all
// succeed through nginx; with plain round robin (the control) uploads land on the wrong replica.
//   node scripts/verify-deployment.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { download } from '../src/downloads.ts';
import { t } from '../src/schema.ts';
import { createApueServer, type Handlers } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { testCert } from '../test/helpers.ts';

const api = defineApi({
  'files.size': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.object({ size: t.number(), replica: t.string() }) }),
  'export.get': op({ effect: 'safe', input: t.object({ n: t.number() }), output: t.download() }),
});
const NGINX = 'nginx:1.29-alpine';
const root = join(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'apue-deploy-'));
const { key, cert } = testCert();
writeFileSync(join(work, 'key.pem'), key);
writeFileSync(join(work, 'cert.pem'), cert);

const replicas = await Promise.all(
  ['eu-1', 'eu-2'].map(async (instance) => {
    const handlers: Handlers<typeof api> = {
      'files.size': ({ data }) => ({ size: data.byteLength, replica: instance }),
      'export.get': ({ n }) => download.fromBytes(new Uint8Array(n).fill(7)),
    };
    const server = createApueServer(api, handlers, { key, cert, uploads: {}, instance, resume: { secret: 'one secret shared by all replicas' } });
    return { instance, server, port: await server.listen(0, '0.0.0.0') };
  }),
);

async function throughNginx(config: string): Promise<{ ok: number; failed: number; replicas: Set<string> }> {
  writeFileSync(join(work, 'nginx.conf'), config);
  const name = `apue-deploy-${process.pid}`;
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::8443', '-v', `${work}/nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${work}/cert.pem:/etc/nginx/cert.pem:ro`, '-v', `${work}/key.pem:/etc/nginx/key.pem:ro`, NGINX], { stdio: 'ignore' });
  try {
    execFileSync('docker', ['exec', name, 'nginx', '-t'], { stdio: 'ignore' }); // the config is valid
    const port = /:(\d+)$/.exec(execFileSync('docker', ['port', name, '8443'], { encoding: 'utf8' }).trim().split('\n')[0]!)![1];
    const client = new ApueClient(api, http2Transport(`https://localhost:${port}`, { ca: cert }), { retries: 0 });
    let ok = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      try {
        // automatic upload (POST /$uploads, then PATCH by path), then the call (routed by header)
        const result = await client.call('files.size', { data: new Uint8Array(1000 + i) });
        if (result.size !== 1000 + i) throw new Error('wrong size');
        seen.add(result.replica);
        // a download resource, fetched through nginx (routed by path)
        const file = await client.call('export.get', { n: 100 + i });
        if ((await file.bytes()).byteLength !== 100 + i) throw new Error('wrong download');
        ok++;
      } catch {
        failed++;
      }
    }
    await client.close();
    return { ok, failed, replicas: seen };
  } finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

try {
  const template = readFileSync(join(root, 'docs', 'deployment', 'nginx.conf'), 'utf8');
  const config = template.replace('REPLICA_1', `host.docker.internal:${replicas[0]!.port}`).replaceAll('REPLICA_1', `host.docker.internal:${replicas[0]!.port}`).replaceAll('REPLICA_2', `host.docker.internal:${replicas[1]!.port}`);
  const routed = await throughNginx(config);
  console.log(`routed by replica: ${routed.ok} ok, ${routed.failed} failed, served by ${[...routed.replicas].sort().join(' + ')}`);
  if (routed.failed !== 0 || routed.replicas.size !== 2) throw new Error('routing by replica failed (or did not spread calls over both replicas)');
  // Control: the same nginx without the routing maps — uploads and calls land on different replicas.
  const roundRobin = await throughNginx(config.replace('proxy_pass https://$apue_upstream;', 'proxy_pass https://apue_all;'));
  console.log(`plain round robin (control): ${roundRobin.ok} ok, ${roundRobin.failed} failed`);
  if (roundRobin.failed === 0) throw new Error('the control did not fail: the test would not detect missing routing');
  console.log('verify:deployment OK');
} finally {
  for (const { server } of replicas) await server.close();
  rmSync(work, { recursive: true, force: true });
}
