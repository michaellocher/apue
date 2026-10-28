//-hide
import { ApueClient } from '../../src/index.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { api } from './binary.ts';
const client = new ApueClient(api, http2Transport('https://api.example'));
const photo = new Uint8Array(1024);
const archiveFile = new Blob([new Uint8Array(4096)]);
//-show
// Bytes in a unary input are uploaded first (resumably),
// then referenced as { "$upload": id }.
const { png } = await client.call('images.thumbnail', { image: photo }); // Uint8Array

// A Blob (in browsers: a File from <input type=file>) is sent
// with slice(offset), never read into memory.
await client.call('backups.restore', { name: 'monday', archive: archiveFile });

// Upload once, use the reference in several calls; delete it when done.
const ref = await client.upload(photo);
await client.call('images.thumbnail', { image: ref });
await client.deleteUpload(ref);

// Downloads: a Download object with a plain URL and resumable reads.
const { archive } = await client.call('backups.export', { name: 'monday' });
console.log(archive.url, archive.size, archive.type, archive.sha256, archive.expires);
for await (const chunk of archive.stream()) {
  // resumed with Range + If-Range after a lost connection;
  // SHA-256 verified at the end (Node)
  console.log(chunk.byteLength);
}
const blob = await archive.blob(); // or archive.bytes()
console.log(png.byteLength);
console.log(blob.size);
