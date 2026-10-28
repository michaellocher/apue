// Renders benchmark JSON results (bench/results/<label>.json) as Markdown tables.
//   node bench/report.ts local-mac-final docker-2cpu-1g ...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from './scenarios.ts';

const fmt = (n: number | undefined, unit = '') => (n === undefined ? '' : `${n >= 100 ? Math.round(n).toLocaleString('en') : n.toFixed(2)}${unit}`);
for (const label of process.argv.slice(2)) {
  const { env, rows } = JSON.parse(readFileSync(join(import.meta.dirname, 'results', `${label}.json`), 'utf8')) as {
    env: { label: string; node: string; cpus: number; memMiB: number; notes?: string; date: string };
    rows: Row[];
  };
  console.log(`#### ${env.label}\n\nNode ${env.node}; ${env.notes || `${env.cpus} CPUs, ${env.memMiB} MiB, server and client as separate processes on the same machine`}; ${env.date.slice(0, 16)}Z\n`);
  console.log('| scenario | variant | result | p50 | p99 |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.scenario} | ${r.variant} | ${fmt(r.value)} ${r.unit} | ${fmt(r.p50, ' ms')} | ${fmt(r.p99, ' ms')} |`);
  console.log();
}
