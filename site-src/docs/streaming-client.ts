//-hide
import { ApueClient } from '../../src/index.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { api } from './streaming-api.ts';
const client = new ApueClient(api, http2Transport('https://api.example'));
//-show
// Server stream: breaking out of the loop cancels the call on the server (ctx.signal).
const changes = client.stream('todos.changes', undefined, { resumes: 5 });
for await (const { seq, todo } of changes) {
  console.log(seq, todo.title);
  if (todo.done) break;
}

// Client stream: any AsyncIterable of inputs; the single output arrives at the end.
async function* titles() {
  for (let i = 1; i <= 100; i++) yield { title: `imported #${i}` };
}
const [count] = await Array.fromAsync(client.duplex('todos.import', titles()));

// Bidi stream as a pacing pattern (tiers T1 and T3): each input asks for
// that many more items. Here both requests go out at once; a real consumer
// yields the next one when it has room.
async function* demand() {
  yield { more: 10 };
  yield { more: 10 };
}
for await (const item of client.duplex('feed.paced', demand())) console.log(item.n, count);
