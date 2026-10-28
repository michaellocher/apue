//-hide
import { readFileSync } from 'node:fs';
type Todo = { id: number; title: string; done: boolean };
const todos = new Map<number, Todo>();
const log: Array<{ seq: number; todo: Todo }> = [];
let nextId = 1;
function save(todo: Todo): Todo {
  todos.set(todo.id, todo);
  log.push({ seq: log.length, todo });
  return todo;
}
const key = readFileSync('certs/key.pem');
const cert = readFileSync('certs/cert.pem');
//-show
import { createApueServer, type Handlers } from '../../src/server.ts';
import { ApueError } from '../../src/protocol.ts';
import { api } from './api.ts';

const handlers: Handlers<typeof api> = {
  'todos.get': ({ id }) => {
    const todo = todos.get(id);
    // → 404 with an RFC 9457 problem body
    if (!todo) throw new ApueError(404, 'Not Found', `todo ${id}`);
    return todo;
  },
  'todos.create': ({ title }) => save({ id: nextId++, title, done: false }),
  'todos.changes': async function* (_input, ctx) {
    // Resuming replays everything after the client's last checkpoint.
    let seq = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1;
    for (; seq < log.length && !ctx.signal.aborted; seq++) {
      yield log[seq]!;
      ctx.checkpoint(String(seq));
    }
  },
};

const server = createApueServer(api, handlers, { key, cert });
await server.listen(8443);
