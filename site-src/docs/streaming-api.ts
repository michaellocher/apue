//-hide
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';
import type { Handlers } from '../../src/server.ts';
const Todo = t.object({ id: t.number({ int: true }), title: t.string({ min: 1, max: 200 }), done: t.boolean() });
type Todo = { id: number; title: string; done: boolean };
const changes: Array<{ seq: number; todo: Todo }> = [];
let nextId = 1;
function record(todo: Todo): Todo {
  changes.push({ seq: changes.length, todo });
  return todo;
}
function nextChange(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
const Item = t.object({ n: t.number() });
//-show
export const api = defineApi({
  // Server stream, resumable: checkpoints let clients continue after a lost connection
  'todos.changes': op({
    effect: 'safe', stream: 'server', resumable: true,
    input: t.void(), output: t.object({ seq: t.number(), todo: Todo }),
  }),
  // Client stream: many inputs, one output
  'todos.import': op({
    effect: 'unsafe', stream: 'client',
    input: t.object({ title: t.string({ min: 1, max: 200 }) }), output: t.number(),
  }),
  // Bidi stream: the client asks for more items when it is ready for them
  'feed.paced': op({
    effect: 'safe', stream: 'bidi',
    input: t.object({ more: t.number({ int: true, min: 1, max: 1000 }) }), output: Item,
  }),
});

export const handlers: Handlers<typeof api> = {
  'todos.changes': async function* (_input, ctx) {
    // The change log is the cursor space: resuming replays everything after the checkpoint.
    let seq = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1;
    while (!ctx.signal.aborted) {
      while (seq < changes.length) {
        yield changes[seq]!;
        ctx.checkpoint(String(seq++));   // covers everything yielded so far
      }
      await nextChange(ctx.signal);      // your own wake-up mechanism
    }
  },
  'todos.import': async (inputs) => {
    let count = 0;
    for await (const { title } of inputs) {
      record({ id: nextId++, title, done: false });
      count++;
    }
    return count;
  },
  'feed.paced': async function* (requests) {
    let n = 0;
    for await (const { more } of requests) {
      for (let i = 0; i < more; i++) yield { n: n++ };
    }
  },
};
