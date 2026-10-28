//-hide
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';
import { ApueClient } from '../../src/client.ts';
const api = defineApi({ 'me.get': op({ effect: 'safe', input: t.void(), output: t.object({ user: t.string() }) }) });
const tokens = { current: async () => 'Bearer abc', refresh: async () => {} };
async function dpopProof(method: string, path: string): Promise<string> {
  return `${method} ${path}`;
}
//-show
import { autoTransport } from '../../src/transport-ws.ts';

const client = new ApueClient(api, autoTransport('https://api.example.com'), {
  // Asked before every request (calls, batches, uploads, WebSocket handshakes),
  // so a refreshed token is used from the next request on.
  authorization: () => tokens.current(),
  // Optional per-request headers, e.g. a fresh DPoP proof
  // (over WebSocket only `dpop` travels).
  headers: async ({ method, path }) => ({ dpop: await dpopProof(method, path) }),
});
console.log(await client.call('me.get'));
