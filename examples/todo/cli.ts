// Node client for the todo example: typed calls, a pipelined batch, a resumable stream.
//   node examples/todo/server.ts &   then   node examples/todo/cli.ts
import { readFileSync } from 'node:fs';
import { ApueClient } from '../../src/client.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { todoApi } from './api.ts';

const url = process.env.URL ?? 'https://localhost:8443';
const ca = readFileSync(process.env.CA ?? new URL('../../certs/cert.pem', import.meta.url));
const client = new ApueClient(todoApi, http2Transport(url, { ca }));

const created = await client.call('todos.create', { title: 'write the spec' });
console.log('created', created);

// Create and complete in ONE round trip: the second call references the first one's output.
const batch = client.batch();
const todo = batch.call('todos.create', { title: 'ship apü' });
const done = batch.call('todos.complete', { id: todo.ref('id') });
await batch.send();
console.log('batched', await todo.result, '→', await done.result);

console.log('list', await client.call('todos.list'));

const controller = new AbortController();
setTimeout(() => controller.abort(), 500);
try {
  for await (const change of client.stream('todos.changes', undefined, { signal: controller.signal })) console.log('change', change);
} catch {
  console.log('(stopped watching)');
}
await client.close();
