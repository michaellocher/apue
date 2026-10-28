// API used by the in-browser suite (web-only: imported by the browser and by the Node test).
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';

export const browserApi = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: t.object({ id: t.string(), name: t.string() }) }),
  'users.search': op({ effect: 'safe', input: t.object({ q: t.string(), tags: t.array(t.string()) }), output: t.object({ q: t.string(), count: t.number() }) }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.object({ orderId: t.number() }) }),
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number() }), output: t.number() }),
  'ticker': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'stats.cancelled': op({ effect: 'safe', input: t.void(), output: t.number() }),
  'slow.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'big.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'stats.lastDuplexVersion': op({ effect: 'safe', input: t.void(), output: t.string(), cache: { private: true } }),
  'echo.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.object({ echo: t.number() }) }),
  'flood': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.string() }),
  'stats.flooded': op({ effect: 'safe', input: t.void(), output: t.number(), cache: { private: true } }),
  'files.store': op({ effect: 'unsafe', input: t.object({ data: t.bytes() }), output: t.object({ size: t.number(), sha256: t.string() }) }),
});
