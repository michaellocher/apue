// Window tuning of the node:http2 transport (fixed default; opt-in BDP estimator) under emulated RTT.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { defineApi, op } from '../src/api.ts';
import { ApueClient } from '../src/client.ts';
import { t } from '../src/schema.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { startServer, testCert } from './helpers.ts';
import { latencyProxy } from './latency-proxy.ts';

// Incompressible on purpose: a compressed body would make the window irrelevant.
const blob = new Uint8Array(randomBytes(8 << 20));
const api = defineApi({ blob: op({ effect: 'safe', input: t.void(), output: t.object({ data: t.bytes() }) }) });
let server: { url: string; close(): Promise<void> };
let proxy: { port: number; close(): Promise<void> };
before(async () => {
  server = await startServer(api, { blob: () => ({ data: blob }) });
  proxy = await latencyProxy(Number(new URL(server.url).port), 20); // 40 ms RTT
});
after(async () => {
  await proxy.close();
  await server.close();
});

test('fixed window (default) stays at 4 MiB; BDP mode grows it under 40 ms RTT, bounded by streamWindow', { timeout: 60_000 }, async () => {
  const url = `https://127.0.0.1:${proxy.port}`;
  const fixed = http2Transport(url, { ca: testCert().cert, acceptEncoding: '' });
  const auto = http2Transport(url, { ca: testCert().cert, acceptEncoding: '', windowTuning: 'bdp', streamWindow: 2 << 20 });
  for (const transport of [fixed, auto]) {
    const client = new ApueClient(api, transport);
    assert.equal((await client.call('blob')).data.byteLength, blob.byteLength);
    await client.close();
  }
  assert.equal(fixed.streamWindow, 4 << 20);
  assert.ok(auto.streamWindow > 256 << 10, `bdp window ${auto.streamWindow}`);
  assert.ok(auto.streamWindow <= 2 << 20, `bdp window ${auto.streamWindow} exceeds the bound`);
});
