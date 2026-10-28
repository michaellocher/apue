// client.ts — node client.ts
import { readFileSync } from 'node:fs';
import { ApueClient } from '../../src/index.ts';
import { http2Transport } from '../../src/transport-http2.ts';
import { api } from './api.ts';

const url = process.env.URL ?? 'https://localhost:8443';
const ca = readFileSync('certs/cert.pem');
const client = new ApueClient(api, http2Transport(url, { ca }));

const { text } = await client.call('greetings.get', { name: 'Ada' });
console.log(text);

for await (const { n } of client.stream('greetings.count', { to: 3 })) console.log(n);

await client.close();
