// Benchmark orchestrator: starts bench/server.ts as a separate process, runs the scenarios,
// prints a Markdown table and writes JSON results.
//   node bench/run.ts [--label local] [--duration 3000] [--only unary,stream,bulk,chain] [--server-args="--coalesce 0"]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { testCert } from '../test/helpers.ts';
import { bulk, chain, stream, unary, type Ports, type Row } from './scenarios.ts';

const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'local' },
    duration: { type: 'string', default: '3000' },
    only: { type: 'string', default: 'unary,stream,bulk,chain' },
    'server-args': { type: 'string', default: '' },
    out: { type: 'string', default: join(import.meta.dirname, 'results') },
  },
});

const { key, cert } = testCert();
const certDir = join(values.out, '.certs');
mkdirSync(certDir, { recursive: true });
writeFileSync(join(certDir, 'key.pem'), key);
writeFileSync(join(certDir, 'cert.pem'), cert);

const serverArgs = values['server-args'].split(' ').filter(Boolean);
const child = spawn(process.execPath, [join(import.meta.dirname, 'server.ts'), '--key', join(certDir, 'key.pem'), '--cert', join(certDir, 'cert.pem'), ...serverArgs], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const ports = await new Promise<Ports>((resolve, reject) => {
  createInterface({ input: child.stdout! }).once('line', (line) => resolve(JSON.parse(line)));
  child.once('exit', (code) => reject(new Error(`bench server exited with ${code}`)));
});

const options = { ca: cert, durationMs: Number(values.duration) };
const only = new Set(values.only.split(','));
const rows: Row[] = [];
try {
  if (only.has('unary')) rows.push(...(await unary(ports, options)));
  if (only.has('stream')) rows.push(...(await stream(ports, options)));
  if (only.has('bulk')) rows.push(...(await bulk(ports, options)));
  if (only.has('chain')) rows.push(...(await chain(ports, options)));
} finally {
  child.kill('SIGTERM');
}

const env = {
  label: values.label,
  node: process.version,
  cpus: availableParallelism(),
  cpuModel: cpus()[0]?.model ?? 'unknown',
  memMiB: Math.round(totalmem() / 1024 / 1024),
  serverArgs: serverArgs.join(' '),
  date: new Date().toISOString(),
};
const fmt = (n: number | undefined, unit = '') => (n === undefined ? '' : `${n >= 100 ? Math.round(n).toLocaleString('en') : n.toFixed(2)}${unit}`);
console.log(`\n### ${env.label} — Node ${env.node}, ${env.cpus} CPU(s) visible, ${env.memMiB} MiB, server args: ${env.serverArgs || '(defaults)'}\n`);
console.log('| scenario | variant | result | p50 | p99 |\n|---|---|---|---|---|');
for (const row of rows) {
  console.log(`| ${row.scenario} | ${row.variant} | ${fmt(row.value)} ${row.unit} | ${fmt(row.p50, ' ms')} | ${fmt(row.p99, ' ms')} |`);
}
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, `${values.label}.json`), JSON.stringify({ env, rows }, null, 2) + '\n');
