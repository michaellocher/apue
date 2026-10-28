// examples/hello/api.ts — the contract, shared by server and clients
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';

export const api = defineApi({
  'greetings.get': op({
    effect: 'safe',                       // a read: GET, cacheable, retried
    input: t.object({ name: t.string({ min: 1, max: 100 }) }),
    output: t.object({ text: t.string() }),
    cache: { maxAge: 60 },                // Cache-Control: max-age=60
  }),
  'greetings.count': op({
    effect: 'safe',
    stream: 'server',                     // many messages in one response
    input: t.object({ to: t.number({ int: true, min: 1, max: 10 }) }),
    output: t.object({ n: t.number() }),
  }),
});
