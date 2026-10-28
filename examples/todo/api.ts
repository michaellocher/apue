// The contract — shared by server, Node client and browser (TS-first: types and validation from one place).
import { defineApi, op } from '../../src/api.ts';
import { t, type Infer } from '../../src/schema.ts';

export const Todo = t.object({ id: t.number({ int: true }), title: t.string({ min: 1, max: 200 }), done: t.boolean() });
export type Todo = Infer<typeof Todo>;

export const todoApi = defineApi({
  'todos.list': op({ effect: 'safe', input: t.void(), output: t.array(Todo), cache: { maxAge: 0 } }),
  'todos.get': op({ effect: 'safe', input: t.object({ id: t.number({ int: true }) }), output: Todo }),
  'todos.create': op({ effect: 'unsafe', input: t.object({ title: t.string({ min: 1, max: 200 }) }), output: Todo }),
  'todos.complete': op({ effect: 'idempotent', input: t.object({ id: t.number({ int: true }) }), output: Todo }),
  // Every change as it happens; resumable after network loss (no sticky sessions).
  'todos.changes': op({ effect: 'safe', stream: 'server', resumable: true, input: t.void(), output: t.object({ seq: t.number(), todo: Todo }) }),
  // Bulk import as a client stream (fetch upload streaming in Chromium, WebSocket elsewhere).
  'todos.import': op({ effect: 'unsafe', stream: 'client', input: t.object({ title: t.string({ min: 1, max: 200 }) }), output: t.number() }),
});
