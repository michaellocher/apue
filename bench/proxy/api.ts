// API used to probe intermediaries (bench/proxy/run.sh).
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';

export const proxyApi = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: t.object({ id: t.string() }) }),
  'users.search': op({ effect: 'safe', input: t.object({ tags: t.array(t.string()) }), output: t.number() }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'slow.stream': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'ticker': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'stats.cancelled': op({ effect: 'safe', input: t.void(), output: t.number(), cache: { private: true } }),
  'echo.duplex': op({ effect: 'unsafe', stream: 'bidi', input: t.number(), output: t.number() }),
  'big.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
});
