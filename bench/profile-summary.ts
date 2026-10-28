// Summarises a V8 .cpuprofile: self time per function (top N), to find hot spots.
//   node bench/profile-summary.ts file.cpuprofile [--top 25]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { top: { type: 'string', default: '25' } } });
const profile = JSON.parse(readFileSync(positionals[0]!, 'utf8')) as { nodes: Node[]; samples: number[]; timeDeltas: number[] };
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map<string, number>();
let total = 0;
for (const [i, id] of profile.samples.entries()) {
  const node = byId.get(id)!;
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.replace(/^.*\/(src|bench|test|node:)/, '$1').replace(/^file:\/\//, '');
  const key = `${functionName || '(anonymous)'} ${file ? `${file}:${lineNumber + 1}` : ''}`.trim();
  const dt = profile.timeDeltas[i] ?? 0;
  self.set(key, (self.get(key) ?? 0) + dt);
  total += dt;
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(values.top));
for (const [key, us] of top) console.log(`${((us / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
