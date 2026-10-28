// Builds the published package into dist/: JavaScript + declarations (tsconfig.build.json), the
// code generators' runtime templates (src/<lang>/runtime.*), an executable CLI.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
// Generator templates are read at run time next to the compiled generators.
for (const name of readdirSync(join(root, 'src'))) {
  const dir = join(root, 'src', name);
  if (statSync(dir).isDirectory() && name !== 'entry') cpSync(dir, join(dist, 'src', name), { recursive: true, filter: (path) => !path.includes('__pycache__') && (statSync(path).isDirectory() || !path.endsWith('.ts')) });
}
const cli = join(dist, 'bin', 'apue-types.js');
if (!existsSync(cli)) throw new Error('build: dist/bin/apue-types.js missing');
chmodSync(cli, 0o755);
console.log('built dist/');
