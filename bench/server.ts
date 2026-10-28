// Bench server process: an apü server and a raw node:http2 baseline (minimal JSON / NDJSON
// handlers, no framework) on separate ports. Prints {"apue": port, "raw": port} on stdout.
//   node bench/server.ts [--coalesce 16384] [--no-validate] [--window default|tuned]
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { parseArgs } from 'node:util';
import { createApueServer } from '../src/server.ts';
import { benchApi, benchHandlers, blob, user } from './api.ts';

const { values } = parseArgs({
  options: {
    coalesce: { type: 'string', default: String(16 * 1024) },
    'max-buffered': { type: 'string', default: String(256 * 1024) },
    'no-validate': { type: 'boolean', default: false },
    window: { type: 'string', default: 'tuned' },
    key: { type: 'string' },
    cert: { type: 'string' },
  },
});
const key = readFileSync(values.key!);
const cert = readFileSync(values.cert!);
const tuned = values.window === 'tuned';
const RFC_DEFAULT_WINDOW = 65_535;

const apue = createApueServer(benchApi, benchHandlers, {
  key,
  cert,
  coalesceBytes: Number(values.coalesce),
  maxBufferedBytes: Number(values['max-buffered']),
  validateOutput: !values['no-validate'],
  streamWindow: tuned ? 4 * 1024 * 1024 : RFC_DEFAULT_WINDOW,
  connectionWindow: tuned ? 32 * 1024 * 1024 : RFC_DEFAULT_WINDOW,
});
const apuePort = await apue.listen(0, '127.0.0.1');

// Baseline: what a hand-written node:http2 endpoint costs (no validation, no framing).
const raw = http2.createSecureServer({ key, cert, settings: { initialWindowSize: tuned ? 4 * 1024 * 1024 : RFC_DEFAULT_WINDOW } });
raw.on('connection', (socket: Socket) => socket.setNoDelay(true));
raw.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
  const url = new URL(headers[':path']!, 'https://x');
  if (url.pathname === '/users.get') {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify(user(url.searchParams.get('id') ?? '1')));
  } else if (url.pathname === '/blob.get') {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ data: blob(Number(url.searchParams.get('kb'))) }));
  } else if (url.pathname === '/items.ndjson') {
    // NDJSON with the same coalescing idea, so the comparison isolates framing + validation cost.
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    const n = Number(url.searchParams.get('n'));
    let buffer = '';
    for (let i = 0; i < n; i++) {
      buffer += JSON.stringify({ i, name: 'item', ok: true }) + '\n';
      if (buffer.length >= 16 * 1024) {
        stream.write(buffer);
        buffer = '';
      }
    }
    stream.end(buffer);
  } else {
    stream.respond({ ':status': 404 });
    stream.end();
  }
});
await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
if (tuned) raw.on('session', (session) => session.setLocalWindowSize(32 * 1024 * 1024));

process.stdout.write(JSON.stringify({ apue: apuePort, raw: (raw.address() as AddressInfo).port }) + '\n');
process.on('SIGTERM', async () => {
  await apue.close();
  raw.close();
  process.exit(0);
});
