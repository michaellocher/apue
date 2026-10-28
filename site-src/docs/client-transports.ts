//-hide
import { readFileSync } from 'node:fs';
import { defineApi, op } from '../../src/api.ts';
import { t } from '../../src/schema.ts';
const api = defineApi({ 'ping.get': op({ effect: 'safe', input: t.void(), output: t.string() }) });
//-show
import { ApueClient, fetchTransport } from '../../src/client.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { autoTransport, webSocketTransport } from '../../src/transport-ws.ts';

// Node, server to server: node:http2, full duplex (tier T1), zstd/br/gzip, 4 MiB windows.
const ca = readFileSync('ca.pem');
const node = new ApueClient(api, http2Transport('https://api.internal', { ca }));

// Browsers: fetch for everything; request streams over fetch where the browser can
// stream uploads (Chromium), else over WebSocket (tier T3).
const browser = new ApueClient(api, autoTransport(location.origin));

// Explicit choices
const base = 'https://api.example.com';
const plain = new ApueClient(api, fetchTransport(base, { credentials: 'include' }));
const sockets = new ApueClient(api, webSocketTransport(base, { receiveWindow: 4 * 1024 * 1024 }));

const client = new ApueClient(api, http2Transport('https://api.internal'), {
  retries: 2,          // retry budget for retry-eligible calls (default 2)
  backoffMs: 100,      // full jitter: attempt n waits random [0, 100·2ⁿ] ms …
  maxBackoffMs: 2_000, // … capped at 2 s
});
await client.close();  // waits for upload clean-up, then closes the transport
//-hide
console.log(node, browser, plain, sockets);
//-show
