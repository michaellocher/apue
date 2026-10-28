import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';

const Todo = t.object({
  id: t.number({ int: true }),
  title: t.string({ min: 1, max: 200 }),
  done: t.boolean(),
});

export const api = defineApi({
  'todos.get': op({
    effect: 'safe',                    // → GET, cacheable, ETag/304, retried
    input: t.object({ id: t.number({ int: true }) }),
    output: Todo,
  }),
  'todos.create': op({
    effect: 'unsafe',                  // → POST + Idempotency-Key, safe to retry
    input: t.object({ title: t.string({ min: 1, max: 200 }) }),
    output: Todo,
  }),
  'todos.changes': op({
    effect: 'safe',
    stream: 'server',                  // many messages in one response
    resumable: true,                   // clients resume after a lost connection
    input: t.void(),
    output: t.object({ seq: t.number(), todo: Todo }),
  }),
});
