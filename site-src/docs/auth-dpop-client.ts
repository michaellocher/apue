//-hide
import { defineApi, op, t, fetchTransport } from '../../src/index.ts';
const api = defineApi({ 'me.get': op({ effect: 'safe', input: t.void(), output: t.object({ user: t.string() }) }) });
let token = 'the access token';
//-show
import { ApueClient, createDpopSigner, dpopHeaders } from '../../src/index.ts';

// A P-256 key pair whose private key can't be exported (WebCrypto).
// Keep it (e.g. in IndexedDB) as long as tokens are bound to it: signer.jkt.
const signer = await createDpopSigner();
const origin = 'https://api.example.com';

const client = new ApueClient(api, fetchTransport(origin), {
  authorization: () => `DPoP ${token}`,
  // A fresh proof per request, bound to the token (ath) — over WebSocket too.
  headers: dpopHeaders(signer, origin, () => token),
});
await client.call('me.get');
//-hide
token = '';
//-show
