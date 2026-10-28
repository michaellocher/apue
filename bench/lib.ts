// Tiny benchmark helpers (no dependencies). Median of several timed rounds after warm-up.

export interface Result {
  name: string;
  opsPerSec: number;
  nsPerOp: number;
}

export function bench(name: string, fn: () => void, { ops = 100_000, rounds = 7 } = {}): Result {
  for (let i = 0; i < Math.min(ops, 20_000); i++) fn(); // warm-up / JIT
  const samples: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) fn();
    samples.push(Number(process.hrtime.bigint() - start) / ops);
  }
  const ns = median(samples);
  return { name, nsPerOp: ns, opsPerSec: 1e9 / ns };
}

export async function benchAsync(name: string, fn: () => Promise<number>, { rounds = 5 } = {}): Promise<Result> {
  await fn(); // warm-up
  const samples: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const start = process.hrtime.bigint();
    const ops = await fn();
    samples.push(Number(process.hrtime.bigint() - start) / ops);
  }
  const ns = median(samples);
  return { name, nsPerOp: ns, opsPerSec: 1e9 / ns };
}

export function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function table(results: Result[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => `${r.name.padEnd(width)}  ${Math.round(r.opsPerSec).toLocaleString('en').padStart(12)} ops/s  ${r.nsPerOp.toFixed(0).padStart(7)} ns/op`)
    .join('\n');
}
