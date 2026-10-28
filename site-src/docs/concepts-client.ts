//-hide
import { ApueClient } from '../../src/client.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { api } from './concepts-api.ts';
const client = new ApueClient(api, http2Transport('https://api.example'));
//-show
// GET /users.get?i=%7B%22id%22%3A%2242%22%7D — same input, same URL, same cache entry
const user = await client.call('users.get', { id: '42' });

// Only some fields (?s=address.city,name); paths are checked at compile time
const partial = await client.pick('users.get', { id: '42' }, ['name', 'address.city']);
console.log(user.roles, partial.address?.city);

// POST with a generated Idempotency-Key; a retry after a lost response reuses it
await client.call('users.invite', { email: 'ada@example.com' });

// Your own key (e.g. stored with a form submission), a deadline, cancellation
const controller = new AbortController();
await client.call('users.rename', { id: '42', name: 'Ada' }, {
  idempotencyKey: 'rename-42-7f3a',
  timeoutMs: 2_000,           // apue-timeout: 2000 → 504 when exceeded
  signal: controller.signal,  // abort() resets the stream; the handler's ctx.signal fires
});
