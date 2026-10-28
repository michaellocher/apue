// Resumable uploads over an emulated WAN (research/09 left "not measured over a real network").
// Runs inside the bench container with netem on lo (bench/uploads-wan.sh): one 32 MiB upload through
// the TypeScript client into the file-backed store, then the same with the connection cut half way
// (the client resumes: HEAD for the offset, then only the rest). Prints one JSON line.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApi, op } from '../src/api.ts';
import { ApueClient, type Transport } from '../src/client.ts';
import { t } from '../src/schema.ts';
import { createApueServer } from '../src/server.ts';
import { http2Transport } from '../src/transport-http2.ts';

const MiB = 1024 * 1024;
const size = Number(process.env.UPLOAD_MIB ?? 32) * MiB;
const api = defineApi({ 'files.size': op({ effect: 'unsafe', input: t.object({ file: t.file() }), output: t.number() }) });
const server = createApueServer(api, { 'files.size': ({ file }) => file.size }, {
  key: readFileSync('certs/key.pem'),
  cert: readFileSync('certs/cert.pem'),
  uploads: { maxBytes: 256 * MiB, storeBytes: 1024 * MiB, scopeBytes: 1024 * MiB, directory: mkdtempSync(join(tmpdir(), 'up-')) },
});
const port = await server.listen(0);
const url = `https://localhost:${port}`;
const ca = readFileSync('certs/cert.pem', 'utf8');
const bytes = new Uint8Array(randomBytes(size));

async function timed(transport: Transport): Promise<number> {
  const client = new ApueClient(api, transport, { backoffMs: 1 });
  const start = performance.now();
  const ref = await client.upload(bytes);
  const seconds = (performance.now() - start) / 1000;
  if ((await client.call('files.size', { file: ref })) !== size) throw new Error('size mismatch');
  await client.close();
  return seconds;
}

await timed(http2Transport(url, { ca })); // warm-up (JIT, TLS): not measured
const plain = await timed(http2Transport(url, { ca }));
// The same upload, its PATCH cut after half of the content: the client resumes.
const inner = http2Transport(url, { ca });
let cut = false;
const cutting: Transport = {
  async request(req) {
    if (req.method !== 'PATCH' || cut || !(req.body instanceof Uint8Array)) return inner.request(req);
    cut = true;
    const body = req.body;
    return inner.request({
      ...req,
      body: (async function* () {
        yield body.subarray(0, body.byteLength / 2);
        throw new Error('ECONNRESET (simulated cut)');
      })(),
    });
  },
  close: () => inner.close?.() ?? Promise.resolve(),
};
const resumed = await timed(cutting);
console.log(JSON.stringify({ network: process.env.NETEM ?? 'loopback', mib: size / MiB, uploadSeconds: +plain.toFixed(2), mibPerSecond: +(size / MiB / plain).toFixed(1), cutAndResumedSeconds: +resumed.toFixed(2) }));
await server.close();
