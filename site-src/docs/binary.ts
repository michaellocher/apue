//-hide
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defineApi, op, t } from '../../src/index.ts';
import { createApueServer, type Handlers } from '../../src/server.ts';
const key = readFileSync('certs/key.pem');
const cert = readFileSync('certs/cert.pem');
function thumbnail(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(0, 16);
}
//-show
import { download } from '../../src/downloads.ts';

const GiB = 1024 ** 3;

export const api = defineApi({
  // In-band bytes: BLOB frames in outputs, upload references in unary inputs
  'images.thumbnail': op({
    effect: 'unsafe',
    input: t.object({ image: t.bytes({ max: 8 * 1024 * 1024 }) }),
    output: t.object({ png: t.bytes() }),
  }),
  // Large input: uploaded resumably, read by the handler as a stream
  'backups.restore': op({
    effect: 'unsafe',
    input: t.object({ name: t.string(), archive: t.file({ max: 2 * GiB }) }),
    output: t.object({ sha256: t.string() }),
  }),
  // Large output: a short-lived download URL with Range support
  'backups.export': op({
    effect: 'safe',
    input: t.object({ name: t.string() }),
    output: t.object({ archive: t.download({ type: 'application/zip' }) }),
  }),
});

const handlers: Handlers<typeof api> = {
  'images.thumbnail': ({ image }) => ({ png: thumbnail(image) }), // image: Uint8Array
  'backups.restore': async ({ archive }) => {
    const hash = createHash('sha256');
    // never the whole file in memory (archive.sha256 is known already, too)
    for await (const chunk of archive.stream()) hash.update(chunk);
    return { sha256: hash.digest('hex') };
  },
  'backups.export': async ({ name }) => ({
    archive: await download.fromFile(`/var/backups/${name}.zip`, {
      type: 'application/zip',
      filename: `${name}.zip`,
    }),
  }),
};

const server = createApueServer(api, handlers, {
  key,
  cert,
  // Required for ops with bytes or files in a unary input; off by default.
  uploads: {
    maxBytes: 2 * GiB,
    storeBytes: 8 * GiB,
    directory: '/var/lib/myapi/uploads', // content in files, not in memory
    persistent: true,                    // survives restarts
  },
  // Enabled automatically for t.download(); URLs live 15 minutes by default.
  downloads: { ttlMs: 15 * 60_000 },
});
//-hide
export { server };
//-show
