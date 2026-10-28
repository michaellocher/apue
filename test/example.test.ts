// The todo example runs end to end: server process + CLI process.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';

const root = join(import.meta.dirname, '..');

test('examples/todo: server + CLI (typed calls, batch with ref, list, stream)', { timeout: 30_000 }, async () => {
  const server = spawn(process.execPath, [join(root, 'examples/todo/server.ts')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: server.stdout! }).once('line', resolve);
      server.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
    });
    const port = /localhost:(\d+)/.exec(line)![1];
    const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'examples/todo/cli.ts')], { env: { ...process.env, URL: `https://localhost:${port}` } });
    assert.match(stdout, /created \{ id: 1, title: 'write the spec', done: false \}/);
    assert.match(stdout, /batched \{ id: 2, title: 'ship apü', done: false \} → \{ id: 2, title: 'ship apü', done: true \}/);
    assert.match(stdout, /change \{ seq: 2, todo: \{ id: 2, title: 'ship apü', done: true \} \}/);
  } finally {
    server.kill();
  }
});
