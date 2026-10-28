//-hide
import { readFileSync } from 'node:fs';
const ca = readFileSync('certs/cert.pem');
//-show
import { ApueClient } from '../../src/client.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { api } from './api.ts';

const client = new ApueClient(api, http2Transport('https://localhost:8443', { ca }));

// POST /todos.create with a generated Idempotency-Key
const todo = await client.call('todos.create', { title: 'buy milk' });

// GET /todos.get?i={"id":1} — cacheable, typed result
const same = await client.call('todos.get', { id: todo.id });
console.log(same.title);

// A server stream; resumes after network loss, break cancels it
for await (const change of client.stream('todos.changes')) {
  console.log(change.seq, change.todo.done);
}

// @ts-expect-error — title must be a string: a compile error,
// and at runtime validated before anything is sent
await client.call('todos.create', { title: 42 });
