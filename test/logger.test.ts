// The server's logger option: server-side failures go to it (not the console); client mistakes and
// disconnects are not logged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { t } from '../src/schema.ts';
import { startServer } from './helpers.ts';

const api = defineApi({
  'boom': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'bad.output': op({ effect: 'safe', input: t.void(), output: t.number() }),
  'echo': op({ effect: 'safe', input: t.object({ n: t.number() }), output: t.number() }),
});

test('handler errors and invalid output reach the logger; validation errors by clients do not', async (ctx) => {
  const logged: Array<[string, unknown]> = [];
  const consoleErrors = ctx.mock.method(console, 'error', () => {});
  const server = await startServer(api, {
    'boom': () => {
      throw new Error('kaputt');
    },
    'bad.output': () => 'not a number' as unknown as number,
    'echo': ({ n }) => n,
  }, { logger: { error: (message, detail) => logged.push([message, detail]) } });
  ctx.after(() => server.close());
  assert.equal((await fetch(`${server.url}/boom`)).status, 500);
  assert.equal((await fetch(`${server.url}/bad.output`)).status, 500);
  assert.equal((await fetch(`${server.url}/echo?i=${encodeURIComponent('{"n":"x"}')}`)).status, 400);
  assert.deepEqual(logged.map(([message]) => message), ['apü: handler error', 'apü: handler output does not match schema']);
  assert.match(String((logged[0]![1] as Error).message), /kaputt/);
  assert.equal(consoleErrors.mock.callCount(), 0, 'nothing went to the console');
});
