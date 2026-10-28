// Benchmark scenarios. Each returns rows for the report; clients run in this process, the servers
// in a separate one (bench/server.ts), so client and server don't share a CPU core.
import http2 from 'node:http2';
import { ApueClient } from '../src/client.ts';
import { http2Transport } from '../src/transport-http2.ts';
import { benchApi } from './api.ts';
import { percentile } from './lib.ts';

export interface Row {
  scenario: string;
  variant: string;
  value: number;
  unit: string;
  p50?: number;
  p99?: number;
}

export interface Ports {
  apue: number;
  raw: number;
}

export interface Options {
  ca: string;
  durationMs: number;
}

type Client = ApueClient<typeof benchApi>;

/** Identity encoding unless asked: baselines are uncompressed, compression has its own scenario. */
function apueClient(port: number, ca: string, acceptEncoding = ''): Client {
  return new ApueClient(benchApi, http2Transport(`https://127.0.0.1:${port}`, { ca, acceptEncoding }));
}

function rawSession(port: number, ca: string): http2.ClientHttp2Session {
  const session = http2.connect(`https://127.0.0.1:${port}`, { ca, settings: { initialWindowSize: 4 * 1024 * 1024 } });
  session.on('connect', () => session.setLocalWindowSize(32 * 1024 * 1024));
  session.on('error', () => {});
  return session;
}

function rawGet(session: http2.ClientHttp2Session, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = session.request({ ':path': path });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.end();
  });
}

/** Runs `concurrency` workers looping `fn` for `durationMs`; returns ops/s and latency percentiles. */
async function load(concurrency: number, durationMs: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < 50; i++) await fn(); // warm-up
  const latencies: number[] = [];
  const deadline = performance.now() + durationMs;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const t0 = performance.now();
        await fn();
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = performance.now() - started;
  return { opsPerSec: latencies.length / (elapsed / 1000), p50: percentile(latencies, 0.5), p99: percentile(latencies, 0.99) };
}

export async function unary(ports: Ports, { ca, durationMs }: Options): Promise<Row[]> {
  const rows: Row[] = [];
  const client = apueClient(ports.apue, ca);
  const session = rawSession(ports.raw, ca);
  for (const concurrency of [1, 32]) {
    const variants: Array<[string, () => Promise<unknown>]> = [
      ['raw node:http2 GET', () => rawGet(session, '/users.get?id=42').then((b) => JSON.parse(b.toString()))],
      ['apü safe op (GET)', () => client.call('users.get', { id: '42' })],
      ['apü unsafe op (POST + key)', () => client.call('users.update', { id: '42', name: 'x' })],
    ];
    for (const [variant, fn] of variants) {
      const result = await load(concurrency, durationMs, fn);
      rows.push({ scenario: `unary c=${concurrency}`, variant, value: result.opsPerSec, unit: 'req/s', p50: result.p50, p99: result.p99 });
    }
  }
  await client.close();
  session.close();
  return rows;
}

export async function stream(ports: Ports, { ca }: Options, n = 200_000): Promise<Row[]> {
  const client = apueClient(ports.apue, ca);
  const zstdClient = apueClient(ports.apue, ca, 'zstd');
  const session = rawSession(ports.raw, ca);
  const best = async (fn: () => Promise<number>) => {
    await fn();
    const rates: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const count = await fn();
      if (count !== n) throw new Error(`expected ${n} items, got ${count}`);
      rates.push(count / ((performance.now() - t0) / 1000));
    }
    return Math.max(...rates);
  };
  const rows: Row[] = [
    {
      scenario: `server stream ${n / 1000}k small msgs`,
      variant: 'raw NDJSON (split + JSON.parse)',
      unit: 'msg/s',
      value: await best(async () => {
        const req = session.request({ ':path': `/items.ndjson?n=${n}` });
        req.end();
        req.setEncoding('utf8');
        let count = 0;
        let rest = '';
        for await (const chunk of req as AsyncIterable<string>) {
          const lines = (rest + chunk).split('\n');
          rest = lines.pop()!;
          for (const line of lines) if (JSON.parse(line)) count++;
        }
        return count;
      }),
    },
    {
      scenario: `server stream ${n / 1000}k small msgs`,
      variant: 'apü stream (frames, validated)',
      unit: 'msg/s',
      value: await best(async () => {
        let count = 0;
        for await (const _ of client.stream('items.stream', { n })) count++;
        return count;
      }),
    },
    {
      scenario: `server stream ${n / 1000}k small msgs`,
      variant: 'apü stream + zstd',
      unit: 'msg/s',
      value: await best(async () => {
        let count = 0;
        for await (const _ of zstdClient.stream('items.stream', { n })) count++;
        return count;
      }),
    },
  ];
  await client.close();
  await zstdClient.close();
  session.close();
  return rows;
}

export async function bulk(ports: Ports, { ca }: Options, kb = 1024, repeats = 20): Promise<Row[]> {
  const client = apueClient(ports.apue, ca);
  const session = rawSession(ports.raw, ca);
  const rate = async (fn: () => Promise<unknown>) => {
    await fn();
    const t0 = performance.now();
    for (let i = 0; i < repeats; i++) await fn();
    return (kb * repeats) / 1024 / ((performance.now() - t0) / 1000);
  };
  const rows: Row[] = [
    { scenario: `bulk ${kb} KiB responses`, variant: 'raw node:http2 (+ JSON.parse)', unit: 'MiB/s', value: await rate(() => rawGet(session, `/blob.get?kb=${kb}`).then((b) => JSON.parse(b.toString()))) },
    { scenario: `bulk ${kb} KiB responses`, variant: 'apü safe op', unit: 'MiB/s', value: await rate(() => client.call('blob.get', { kb })) },
  ];
  await client.close();
  session.close();
  return rows;
}

export async function chain(ports: Ports, { ca }: Options, depth = 3, repeats = 20): Promise<Row[]> {
  const client = apueClient(ports.apue, ca);
  const time = async (fn: () => Promise<unknown>) => {
    await fn();
    const samples: number[] = [];
    for (let i = 0; i < repeats; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99) };
  };
  const sequential = await time(async () => {
    let n = 0;
    for (let i = 0; i < depth; i++) n = (await client.call('chain.step', { n })).n;
    return n;
  });
  const batched = await time(async () => {
    const batch = client.batch();
    let last = batch.call('chain.step', { n: 0 });
    for (let i = 1; i < depth; i++) last = batch.call('chain.step', { n: last.ref('n') });
    await batch.send();
    return last.result;
  });
  await client.close();
  return [
    { scenario: `${depth} dependent calls`, variant: 'sequential calls', unit: 'ms', value: sequential.p50, p50: sequential.p50, p99: sequential.p99 },
    { scenario: `${depth} dependent calls`, variant: 'apü batch (1 round trip)', unit: 'ms', value: batched.p50, p50: batched.p50, p99: batched.p99 },
  ];
}

/** Payload throughput and bytes on the wire per content-coding (1 MiB JSON-ish responses). */
export async function compression(ports: Ports, { ca }: Options, kb = 1024, repeats = 10): Promise<Row[]> {
  const rows: Row[] = [];
  const session = rawSession(ports.apue, ca);
  for (const coding of ['', 'gzip', 'br', 'zstd']) {
    const client = new ApueClient(benchApi, http2Transport(`https://127.0.0.1:${ports.apue}`, { ca, acceptEncoding: coding }));
    await client.call('blob.get', { kb });
    const t0 = performance.now();
    for (let i = 0; i < repeats; i++) await client.call('blob.get', { kb });
    const mibs = (kb * repeats) / 1024 / ((performance.now() - t0) / 1000);
    const wire = await wireBytes(session, `/blob.get?i=${encodeURIComponent(JSON.stringify({ kb }))}`, coding);
    rows.push({ scenario: `compression, ${kb} KiB JSON`, variant: `${coding || 'identity'} (wire ${Math.round(wire / 1024)} KiB)`, unit: 'MiB/s', value: mibs });
    await client.close();
  }
  session.close();
  return rows;
}

function wireBytes(session: http2.ClientHttp2Session, path: string, coding: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = session.request({ ':path': path, ...(coding ? { 'accept-encoding': coding } : {}) });
    let bytes = 0;
    req.on('data', (chunk: Buffer) => (bytes += chunk.byteLength));
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
    req.end();
  });
}

/** Download throughput with the RFC default 64 KiB receive window vs tuned windows (needs latency to matter). */
export async function window(ports: Ports, { ca }: Options, kb = 4096, repeats = 3): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [variant, streamWindow, connectionWindow] of [
    ['client window 64 KiB (RFC default)', 65_535, 65_535],
    ['client window 4 MiB / 32 MiB (apü default)', 4 * 1024 * 1024, 32 * 1024 * 1024],
  ] as const) {
    const client = new ApueClient(benchApi, http2Transport(`https://127.0.0.1:${ports.apue}`, { ca, windowTuning: 'fixed', streamWindow, connectionWindow, acceptEncoding: '' }));
    await client.call('blob.get', { kb: 64 });
    const t0 = performance.now();
    for (let i = 0; i < repeats; i++) await client.call('blob.get', { kb });
    rows.push({ scenario: `download ${kb / 1024} MiB, uncompressed`, variant, unit: 'MiB/s', value: (kb * repeats) / 1024 / ((performance.now() - t0) / 1000) });
    await client.close();
  }
  return rows;
}

/** gRPC (@grpc/grpc-js, TLS) vs apü on the same shapes: unary c=1/c=32 and a server stream. */
export async function grpcComparison(ports: Ports & { grpc: number }, options: Options, n = 200_000): Promise<Row[]> {
  const { grpc, proto } = await import('./grpc/load.ts');
  // Node refuses an IP address as TLS servername; the cert also covers DNS:localhost.
  const client = new proto.bench.Bench(`127.0.0.1:${ports.grpc}`, grpc.credentials.createSsl(Buffer.from(options.ca)), {
    'grpc.ssl_target_name_override': 'localhost',
  }) as unknown as {
    GetUser(request: { id: string }, callback: (error: Error | null, value: unknown) => void): void;
    Items(request: { n: number }): AsyncIterable<unknown>;
    close(): void;
  };
  const getUser = () => new Promise<unknown>((resolve, reject) => client.GetUser({ id: '42' }, (error, value) => (error ? reject(error) : resolve(value))));
  const apue = apueClient(ports.apue, options.ca);
  const rows: Row[] = [];
  for (const concurrency of [1, 32]) {
    for (const [variant, fn] of [
      ['gRPC (grpc-js) unary', getUser],
      ['apü safe op (GET)', () => apue.call('users.get', { id: '42' })],
    ] as const) {
      const result = await load(concurrency, options.durationMs, fn);
      rows.push({ scenario: `vs gRPC: unary c=${concurrency}`, variant, value: result.opsPerSec, unit: 'req/s', p50: result.p50, p99: result.p99 });
    }
  }
  const best = async (fn: () => Promise<number>) => {
    await fn();
    const rates: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const count = await fn();
      if (count !== n) throw new Error(`expected ${n} items, got ${count}`);
      rates.push(count / ((performance.now() - t0) / 1000));
    }
    return Math.max(...rates);
  };
  rows.push({
    scenario: `vs gRPC: server stream ${n / 1000}k small msgs`,
    variant: 'gRPC (grpc-js) server stream',
    unit: 'msg/s',
    value: await best(async () => {
      let count = 0;
      for await (const _ of client.Items({ n })) count++;
      return count;
    }),
  });
  rows.push({
    scenario: `vs gRPC: server stream ${n / 1000}k small msgs`,
    variant: 'apü stream (validated)',
    unit: 'msg/s',
    value: await best(async () => {
      let count = 0;
      for await (const _ of apue.stream('items.stream', { n })) count++;
      return count;
    }),
  });
  client.close();
  await apue.close();
  return rows;
}

/**
 * Head-of-line check: unary latency alone vs. while bulk downloads run on the same connection,
 * for several client stream windows (bytes of one stream allowed in flight).
 */
export async function multiplex(ports: Ports, { ca }: Options): Promise<Row[]> {
  const rows: Row[] = [];
  for (const window of [4 * 1024 * 1024, 1024 * 1024, 256 * 1024, 'auto'] as const) {
    const tuning = window === 'auto' ? { windowTuning: 'bdp' as const } : { windowTuning: 'fixed' as const, streamWindow: window };
    const client = new ApueClient(benchApi, http2Transport(`https://127.0.0.1:${ports.apue}`, { ca, acceptEncoding: '', ...tuning }));
    const latencies = async (calls: number) => {
      const samples: number[] = [];
      for (let i = 0; i < calls; i++) {
        const t0 = performance.now();
        await client.call('users.get', { id: String(i) });
        samples.push(performance.now() - t0);
      }
      return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99) };
    };
    await latencies(200); // warm-up
    const scenario = `multiplexing, one connection, stream window ${window === 'auto' ? 'auto (BDP)' : `${window / 1024} KiB`}`;
    if (window === 4 * 1024 * 1024) {
      const alone = await latencies(500);
      rows.push({ scenario, variant: 'unary latency, idle connection', unit: 'ms', value: alone.p50, p50: alone.p50, p99: alone.p99 });
    }
    for (const [label, download] of [
      // 8 MiB JSON: stringify/hash/parse block both event loops for milliseconds per response.
      ['8 MiB JSON downloads', async () => (await client.call('blob.get', { kb: 8192 })).data.length],
      // 8 MiB as BLOB frames: no large JSON work, so mostly transport queuing remains.
      ['8 MiB binary downloads', async () => (await client.call('bytes.get', { kb: 8192 })).data.byteLength],
    ] as const) {
      let downloading = true;
      let downloaded = 0;
      const bulk = (async () => {
        while (downloading) downloaded += await download();
      })();
      await new Promise((resolve) => setTimeout(resolve, 100)); // let the downloads get going
      const t0 = performance.now();
      const loaded = await latencies(500);
      const seconds = (performance.now() - t0) / 1000;
      downloading = false;
      await bulk;
      rows.push({
        scenario,
        variant: `unary latency during ${label} (${Math.round(downloaded / 1048576 / seconds)} MiB/s alongside)`,
        unit: 'ms',
        value: loaded.p50,
        p50: loaded.p50,
        p99: loaded.p99,
      });
    }
    await client.close();
  }
  return rows;
}
