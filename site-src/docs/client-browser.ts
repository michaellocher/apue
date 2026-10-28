//-hide
import { defineApi, op, t } from '../../src/index.ts';
const api = defineApi({
  'todos.create': op({ effect: 'unsafe', input: t.object({ title: t.string({ min: 1 }) }), output: t.object({ id: t.number() }) }),
  'todos.import': op({ effect: 'unsafe', stream: 'client', input: t.object({ title: t.string({ min: 1 }) }), output: t.number() }),
});
async function* titles() {
  yield { title: 'a' };
}
//-show
import { ApueClient, fetchTransport } from '../../src/index.ts';
import { autoTransport } from '../../src/transport-ws.ts';

// Same origin: no CORS, no preflights. fetch for calls and response streams (HTTP caching, HTTP/2).
const client = new ApueClient(api, fetchTransport(location.origin));
// Request streams: fetch where it can stream uploads to this server (probed once), else WebSocket.
const uploads = new ApueClient(api, autoTransport(location.origin));

await client.call('todos.create', { title: 'buy milk' }); // validated before sending, safe to retry
const [count] = await Array.fromAsync(uploads.duplex('todos.import', titles()));
//-hide
void count;
//-show
