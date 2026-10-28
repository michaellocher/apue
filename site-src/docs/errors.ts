//-hide
import { defineApi, op, ApueClient, t } from '../../src/index.ts';
import type { Handlers } from '../../src/server.ts';
import { http2Transport } from '../../src/transport-http2.ts';
const api = defineApi({
  'orders.cancel': op({ effect: 'idempotent', input: t.object({ id: t.string() }), output: t.object({ id: t.string(), state: t.string() }) }),
});
const orders = new Map<string, { id: string; state: string }>();
//-show
import { ApueError } from '../../src/index.ts';

const handlers: Handlers<typeof api> = {
  'orders.cancel': ({ id }) => {
    const order = orders.get(id);
    if (!order) throw new ApueError(404, 'Not Found', `order ${id}`);
    if (order.state === 'shipped') {
      // status, title, detail, extension members (here: a custom type)
      throw new ApueError(409, 'Conflict', 'order already shipped', {
        type: 'https://example.com/problems/already-shipped',
      });
    }
    if (order.state === 'locked') {
      // … and extra response headers
      throw new ApueError(503, 'Service Unavailable', 'try again shortly',
        { retryable: true }, { 'retry-after': '2' });
    }
    return { ...order, state: 'cancelled' };
  },
};

// Client side: every failure is an ApueError carrying the problem details.
const client = new ApueClient(api, http2Transport('https://api.example'));
try {
  await client.call('orders.cancel', { id: 'o-17' });
} catch (error) {
  if (!(error instanceof ApueError)) throw error;
  console.log(error.status, error.problem.type, error.problem.title, error.problem.detail);
  // validation errors list each field: [{ path, message }]
  if (error.status === 400) console.log(error.problem.fields);
}
//-hide
export { handlers };
//-show
