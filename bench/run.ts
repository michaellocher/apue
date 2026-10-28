// Benchmark orchestrator: starts bench/server.ts as a separate process, runs the scenarios,
// prints a Markdown table and writes JSON results.
//   node bench/run.ts [--label local] [--duration 3000] [--only unary,stream,bulk,chain,compression,window,multiplex,grpc]
//                     [--server-args="--coalesce 0"] [--stream-n 200000] [--notes "..."]
//   Remote server (e.g. another container): --remote 8443,8444 --ca certs/cert.pem
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { testCert } from '../test/helpers.ts';
import { bulk, chain, compression, grpcComparison, multiplex, stream, unary, window, type Ports, type Row } from './scenarios.ts';

const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'local' },
    duration: { type: 'string', default: '3000' },
    only: { type: 'string', default: 'unary,stream,bulk,chain,compression,window,multiplex' },
    'server-args': { type: 'string', default: '' },
    'stream-n': { type: 'string', default: '200000' },
    notes: { type: 'string', default: '' },
    remote: { type: 'string' },
    ca: { type: 'string' },
    out: { type: 'string', default: join(import.meta.dirname, 'results') },
  },
});

const serverArgs = values['server-args'].split(' ').filter(Boolean);
let cert: string;
let ports: Ports;
let child: ReturnType<typeof spawn> | undefined;
if (values.remote) {
  const [apue, raw] = values.remote.split(',').map(Number);
  ports = { apue: apue!, raw: raw! };
  cert = readFileSync(values.ca!, 'utf8');
} else {
  const generated = testCert();
  cert = generated.cert;
  const certDir = join(values.out, '.certs');
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, 'key.pem'), generated.key);
  writeFileSync(join(certDir, 'cert.pem'), cert);
  const spawned = spawn(process.execPath, [join(import.meta.dirname, 'server.ts'), '--key', join(certDir, 'key.pem'), '--cert', join(certDir, 'cert.pem'), ...serverArgs], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child = spawned;
  ports = await new Promise<Ports>((resolve, reject) => {
    createInterface({ input: spawned.stdout! }).once('line', (line) => resolve(JSON.parse(line)));
    spawned.once('exit', (code) => reject(new Error(`bench server exited with ${code}`)));
  });
}

const options = { ca: cert, durationMs: Number(values.duration) };
const only = new Set(values.only.split(','));
const rows: Row[] = [];
try {
  if (only.has('unary')) rows.push(...(await unary(ports, options)));
  if (only.has('stream')) rows.push(...(await stream(ports, options, Number(values['stream-n']))));
  if (only.has('bulk')) rows.push(...(await bulk(ports, options)));
  if (only.has('chain')) rows.push(...(await chain(ports, options)));
  if (only.has('compression')) rows.push(...(await compression(ports, options)));
  if (only.has('window')) rows.push(...(await window(ports, options)));
  if (only.has('multiplex')) rows.push(...(await multiplex(ports, options)));
  if (only.has('grpc')) {
    // gRPC baseline server in its own process (dev dependency @grpc/grpc-js; local runs only).
    const certDir = join(values.out, '.certs');
    const grpcServer = spawn(process.execPath, [join(import.meta.dirname, 'grpc', 'server.ts'), '--key', join(certDir, 'key.pem'), '--cert', join(certDir, 'cert.pem')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const { grpc } = await new Promise<{ grpc: number }>((resolve, reject) => {
        createInterface({ input: grpcServer.stdout! }).once('line', (line) => resolve(JSON.parse(line)));
        grpcServer.once('exit', (code) => reject(new Error(`grpc server exited with ${code}`)));
      });
      rows.push(...(await grpcComparison({ ...ports, grpc }, options, Number(values['stream-n']))));
    } finally {
      grpcServer.kill('SIGTERM');
    }
  }
} finally {
  child?.kill('SIGTERM');
}

const env = {
  label: values.label,
  node: process.version,
  cpus: availableParallelism(),
  cpuModel: cpus()[0]?.model ?? 'unknown',
  memMiB: Math.round(totalmem() / 1024 / 1024),
  serverArgs: serverArgs.join(' '),
  notes: values.notes,
  date: new Date().toISOString(),
};
const fmt = (n: number | undefined, unit = '') => (n === undefined ? '' : `${n >= 100 ? Math.round(n).toLocaleString('en') : n.toFixed(2)}${unit}`);
console.log(`\n### ${env.label} — Node ${env.node}, client sees ${env.cpus} CPU(s), ${env.memMiB} MiB${env.notes ? `; ${env.notes}` : ''}${env.serverArgs ? `; server args: ${env.serverArgs}` : ''}\n`);
console.log('| scenario | variant | result | p50 | p99 |\n|---|---|---|---|---|');
for (const row of rows) {
  console.log(`| ${row.scenario} | ${row.variant} | ${fmt(row.value)} ${row.unit} | ${fmt(row.p50, ' ms')} | ${fmt(row.p99, ' ms')} |`);
}
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, `${values.label}.json`), JSON.stringify({ env, rows }, null, 2) + '\n');
