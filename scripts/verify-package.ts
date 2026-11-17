// Verifies the package as users get it: `npm pack`, install the tarball into a fresh project (no
// network: the package has no dependencies), then use every entry point from JavaScript — a server
// and a client talking over TLS, a download, DPoP, the CLI generating TypeScript (typechecked against
// the installed declarations), Python, Go, Java and Swift. Node strips types only outside
// node_modules, so this is the only way to know the published JavaScript works.
// `npm run verify:package` (after `npm run build`).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'apue-verify-'));
const run = (cmd: string, args: string[], cwd = work) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], root)) as Array<{ filename: string; files: Array<{ path: string }>; size: number }>;
  const { filename, files, size } = packed[0]!;
  const paths = files.map((f) => f.path);
  const unexpected = paths.filter((p) => !/^(dist\/(src|bin)\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(p));
  if (unexpected.length) throw new Error(`unexpected files in the package: ${unexpected.join(', ')}`);
  for (const required of ['dist/src/index.js', 'dist/src/index.d.ts', 'dist/bin/apue-types.js', 'dist/src/python/runtime.py', 'dist/src/go/runtime.go', 'dist/src/java/Runtime.java', 'dist/src/swift/Runtime.swift', 'LICENSE', 'README.md']) {
    if (!paths.includes(required)) throw new Error(`missing from the package: ${required}`);
  }
  console.log(`package: ${filename}, ${paths.length} files, ${(size / 1024).toFixed(0)} KiB`);
  // npm silently rewrites manifest fields it considers invalid (it once "corrected" the bin path);
  // `npm publish --dry-run` reports those corrections — the package.json must be what users get.
  const publish = spawnSync('npm', ['publish', '--dry-run', '--ignore-scripts', '--tag', 'beta'], { cwd: root, encoding: 'utf8' });
  if (publish.status !== 0 || /auto-corrected|errors corrected/.test(publish.stderr)) throw new Error(`npm publish --dry-run:\n${publish.stderr}`);

  const app = join(work, 'app');
  execFileSync('mkdir', ['-p', app]);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--offline', join(work, filename)], app);
  run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-keyout', 'key.pem', '-out', 'cert.pem', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], app);

  writeFileSync(join(app, 'api.mjs'), `
import { defineApi, op, t } from '@michaellocher/apue';
export const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: t.object({ id: t.string(), name: t.string() }) }),
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number() }), output: t.number() }),
  'export.get': op({ effect: 'safe', input: t.void(), output: t.download() }),
});
`);
  writeFileSync(join(app, 'server.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs';
import { createApueServer } from '@michaellocher/apue/server';
import { download } from '@michaellocher/apue/downloads';
import { api } from './api.mjs';
const server = createApueServer(api, {
  'users.get': ({ id }) => ({ id, name: 'user ' + id }),
  'count.up': async function* ({ to }) { for (let i = 1; i <= to; i++) yield i; },
  'export.get': () => download.fromBytes(new TextEncoder().encode('exported')),
}, { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') });
const port = await server.listen(0);
writeFileSync('port.txt', String(port));
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
`);
  writeFileSync(join(app, 'client.mjs'), `
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { ApueClient, ApueError } from '@michaellocher/apue';
import { http2Transport } from '@michaellocher/apue/http2';
import { webSocketTransport, autoTransport } from '@michaellocher/apue/websocket';
import { generateApi, generatePython } from '@michaellocher/apue/codegen';
import { api } from './api.mjs';
const url = 'https://127.0.0.1:' + readFileSync('port.txt', 'utf8');
const client = new ApueClient(api, http2Transport(url, { ca: readFileSync('cert.pem', 'utf8') }));
const user = await client.call('users.get', { id: 'a' });
const items = await Array.fromAsync(client.stream('count.up', { to: 3 }));
const exported = new TextDecoder().decode(await (await client.call('export.get')).bytes());
let problem;
try { await client.call('users.get', { id: 5 }); } catch (e) { problem = e instanceof ApueError ? e.status : String(e); }
await client.close();
console.log(JSON.stringify({ user, items, exported, problem, entries: [typeof webSocketTransport, typeof autoTransport, typeof generateApi, typeof generatePython] }));
process.exit(0);
`);
  const server = execFileSync('sh', ['-c', 'node server.mjs > server.log 2>&1 & echo $!'], { cwd: app, encoding: 'utf8' }).trim();
  try {
    for (let i = 0; i < 50; i++) {
      try {
        readFileSync(join(app, 'port.txt'));
        break;
      } catch {
        execFileSync('sleep', ['0.1']);
      }
    }
    const result = JSON.parse(run('node', ['client.mjs'], app));
    const expected = { user: { id: 'a', name: 'user a' }, items: [1, 2, 3], exported: 'exported', problem: 400, entries: ['function', 'function', 'function', 'function'] };
    if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error(`client result ${JSON.stringify(result)} ≠ ${JSON.stringify(expected)}`);
    console.log('runtime: server, client (unary, stream, download, problem) and all entry points work from the installed package');
    writeFileSync(join(app, 'dpop.mjs'), `
import { readFileSync } from 'node:fs';
import { ApueClient, createDpopSigner, dpopHeaders } from '@michaellocher/apue';
import { createApueServer, dpopVerifier } from '@michaellocher/apue/server';
import { http2Transport } from '@michaellocher/apue/http2';
import { api } from './api.mjs';
const dpop = dpopVerifier();
const server = createApueServer(api, {
  'users.get': ({ id }, ctx) => ({ id, name: ctx.principal }),
  'count.up': async function* () {},
  'export.get': () => { throw new Error('unused'); },
}, { key: readFileSync('key.pem'), cert: readFileSync('cert.pem'), principal: async (request) => (await dpop(request)).jkt });
const url = 'https://127.0.0.1:' + await server.listen(0);
const signer = await createDpopSigner();
const client = new ApueClient(api, http2Transport(url, { ca: readFileSync('cert.pem', 'utf8') }), { headers: dpopHeaders(signer, url) });
const bound = (await client.call('users.get', { id: 'a' })).name === signer.jkt;
const unsigned = new ApueClient(api, http2Transport(url, { ca: readFileSync('cert.pem', 'utf8') }));
const refused = await unsigned.call('users.get', { id: 'a' }).then(() => 0, (e) => e.status);
await client.close();
await unsigned.close();
await server.close();
console.log(JSON.stringify({ bound, refused }));
process.exit(0);
`);
    const dpop = run('node', ['dpop.mjs'], app).trim();
    if (dpop !== JSON.stringify({ bound: true, refused: 401 })) throw new Error(`DPoP from the package: ${dpop}`);
    console.log('dpop: signer (apue) and verifier (apue/server) work together from the installed package');

    const url = `https://127.0.0.1:${readFileSync(join(app, 'port.txt'), 'utf8')}`;
    run(join(app, 'node_modules', '.bin', 'apue-types'), [url, '--ca', 'cert.pem', '--out', 'api.gen.ts'], app);
    if (!readFileSync(join(app, 'api.gen.ts'), 'utf8').includes("from '@michaellocher/apue';")) throw new Error('generated TypeScript does not import from the package');
    writeFileSync(join(app, 'use.ts'), `import { ApueClient } from '@michaellocher/apue';\nimport { http2Transport } from '@michaellocher/apue/http2';\nimport { api } from './api.gen.ts';\nconst c = new ApueClient(api, http2Transport('https://x'));\nconst u: { id: string; name: string } = await c.call('users.get', { id: 'a' });\n// @ts-expect-error: wrong input type\nawait c.call('users.get', { id: 1 });\nvoid u;\n`);
    writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'esnext', module: 'nodenext', strict: true, noEmit: true, allowImportingTsExtensions: true, types: ['node'], skipLibCheck: false }, files: ['use.ts'] }));
    run(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(app, 'tsconfig.json'), '--typeRoots', join(root, 'node_modules', '@types')], app);
    console.log('types: generated TypeScript imports from the package and typechecks against its declarations');
    run(join(app, 'node_modules', '.bin', 'apue-types'), [url, '--ca', 'cert.pem', '--lang', 'python', '--out', 'api_client.py'], app);
    run('python3', ['-m', 'py_compile', 'api_client.py'], app);
    console.log('python: the CLI from the package generates a compiling Python client');
    const has = (tool: string) => {
      try {
        execFileSync(tool, ['--version'], { stdio: 'ignore' });
        return true;
      } catch {
        try {
          execFileSync(tool, ['version'], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      }
    };
    if (has('go')) {
      execFileSync('mkdir', ['-p', join(app, 'goclient')]);
      run(join(app, 'node_modules', '.bin', 'apue-types'), [url, '--ca', 'cert.pem', '--lang', 'go', '--package', 'api', '--out', join('goclient', 'api.go')], app);
      writeFileSync(join(app, 'goclient', 'go.mod'), 'module example.com/goclient\n\ngo 1.24\n');
      execFileSync('go', ['vet', './...'], { cwd: join(app, 'goclient'), stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local' } });
      console.log('go: the CLI from the package generates a Go client that passes go vet');
    } else console.log('go: skipped (no go)');
    if (has('javac')) {
      run(join(app, 'node_modules', '.bin', 'apue-types'), [url, '--ca', 'cert.pem', '--lang', 'java', '--out', 'Api.java'], app);
      run('javac', ['-d', join(app, 'classes'), 'Api.java'], app);
      console.log('java: the CLI from the package generates a Java client that compiles');
    } else console.log('java: skipped (no javac)');
    if (has('swiftc')) {
      run(join(app, 'node_modules', '.bin', 'apue-types'), [url, '--ca', 'cert.pem', '--lang', 'swift', '--out', 'Api.swift'], app);
      run('swiftc', ['-swift-version', '6', '-typecheck', 'Api.swift'], app);
      console.log('swift: the CLI from the package generates a Swift client that typechecks');
    } else console.log('swift: skipped (no swiftc)');

    // The README's quick start, verbatim: api.ts, server.ts, client.ts against the installed package.
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const quick = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('### Entry points'));
    const blocks = [...quick.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
    if (blocks.length !== 3) throw new Error(`README quick start: expected 3 code blocks, found ${blocks.length}`);
    const quickPort = String(20000 + Math.floor(Math.random() * 20000));
    const names = ['api.ts', 'server.ts', 'client.ts'];
    blocks.forEach((code, i) => writeFileSync(join(app, names[i]!), code.replaceAll('8443', quickPort)));
    writeFileSync(join(app, 'server.ts'), readFileSync(join(app, 'server.ts'), 'utf8') + "\nprocess.on('SIGTERM', async () => { await server.close(); process.exit(0); });\n");
    const quickServer = execFileSync('sh', ['-c', 'node server.ts > quick.log 2>&1 & echo $!'], { cwd: app, encoding: 'utf8' }).trim();
    try {
      let output = '';
      for (let attempt = 0; attempt < 30 && !output; attempt++) {
        try {
          output = execFileSync('node', ['client.ts'], { cwd: app, encoding: 'utf8', env: { ...process.env, NODE_EXTRA_CA_CERTS: join(app, 'cert.pem') }, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
          execFileSync('sleep', ['0.2']); // the server is still starting
        }
      }
      if (output.trim() !== 'buy milk') throw new Error(`README quick start printed ${JSON.stringify(output)} (server log: ${readFileSync(join(app, 'quick.log'), 'utf8')})`);
      console.log('readme: the quick start runs as written against the installed package');
    } finally {
      execFileSync('kill', [quickServer]);
    }
  } finally {
    execFileSync('kill', [server]);
  }
  console.log('verify:package OK');
} finally {
  rmSync(work, { recursive: true, force: true });
}
