//-hide
import { defineApi, op, ApueClient, t } from '../../src/index.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { ApueError } from '../../src/index.ts';
const Todo = t.object({ id: t.number({ int: true }), title: t.string({ min: 1, max: 200 }), done: t.boolean() });
const api = defineApi({
  'todos.create': op({ effect: 'unsafe', input: t.object({ title: t.string({ min: 1, max: 200 }) }), output: Todo }),
  'todos.complete': op({ effect: 'idempotent', input: t.object({ id: t.number({ int: true }) }), output: Todo }),
  'todos.changes': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.object({ seq: t.number(), todo: Todo }) }),
});
const client = new ApueClient(api, http2Transport('https://api.example'));
//-show
const batch = client.batch();
const todo = batch.call('todos.create', { title: 'ship apü' });
// todo.ref('id') is typed as number and resolved on the server
const done = batch.call('todos.complete', { id: todo.ref('id') });

// One request; resolves when every lane has ended
await batch.send({ timeoutMs: 5_000 });

try {
  console.log(await todo.result, '→', await done.result); // each lane settles on its own
} catch (error) {
  // A failed lane rejects only its own result;
  // its dependents end with 424 failed-dependency.
  if (error instanceof ApueError) console.log(error.status, error.problem.type);
}
