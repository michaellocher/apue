// Todo server: API + web page from one origin (no CORS preflights).
//   node examples/todo/server.ts   →  https://localhost:8443
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, normalize, resolve } from 'node:path';
import { ApueError } from '../../src/protocol.ts';
import { createApueServer, type Exchange, type Handlers } from '../../src/server.ts';
import { testCert } from '../../test/helpers.ts';
import { todoApi, type Todo } from './api.ts';

const todos = new Map<number, Todo>();
const changes: Array<{ seq: number; todo: Todo }> = [];
const listeners = new Set<() => void>();
let nextId = 1;

function record(todo: Todo): Todo {
  todos.set(todo.id, todo);
  changes.push({ seq: changes.length, todo });
  for (const wake of listeners) wake();
  return todo;
}

const handlers: Handlers<typeof todoApi> = {
  'todos.list': () => [...todos.values()],
  'todos.get': ({ id }) => {
    const todo = todos.get(id);
    if (!todo) throw new ApueError(404, 'Not Found', `todo ${id}`);
    return todo;
  },
  'todos.create': ({ title }) => record({ id: nextId++, title, done: false }),
  'todos.complete': ({ id }) => {
    const todo = todos.get(id);
    if (!todo) throw new ApueError(404, 'Not Found', `todo ${id}`);
    return record({ ...todo, done: true });
  },
  'todos.changes': async function* (_input, ctx) {
    // The change log is the cursor space: resuming replays everything after the checkpoint.
    let seq = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1;
    // Debug mode: which change the server got to when the stream ended (diagnoses a stall in CI).
    if (process.env.APUE_DEBUG_STREAMS) ctx.signal.addEventListener('abort', () => console.error(`[changes] ended after yielding up to seq ${seq - 1} of ${changes.length - 1}`), { once: true });
    while (!ctx.signal.aborted) {
      while (seq < changes.length) {
        yield changes[seq]!;
        ctx.checkpoint(String(seq++));
      }
      let wake!: () => void;
      await new Promise<void>((resolve) => {
        wake = resolve;
        listeners.add(wake);
        ctx.signal.addEventListener('abort', wake, { once: true });
      });
      listeners.delete(wake);
    }
  },
  'todos.import': async (inputs) => {
    let count = 0;
    for await (const { title } of inputs) {
      record({ id: nextId++, title, done: false });
      count++;
    }
    return count;
  },
};

// Static files: the page and the type-stripped TypeScript modules it imports (no build step).
const root = resolve(import.meta.dirname, '../..');
/** A self-signed cert (one this example made) that has run out, or will within the hour. */
function renewable(pem: Buffer): boolean {
  const cert = new X509Certificate(pem);
  return cert.issuer === cert.subject && Date.parse(cert.validTo) - Date.now() < 3_600_000;
}

function serveStatic(exchange: Exchange): boolean {
  const path = exchange.url.split('?')[0]!;
  if (path === '/') {
    exchange.send(200, { 'content-type': 'text/html; charset=utf-8' }, readFileSync(join(import.meta.dirname, 'index.html')));
    return true;
  }
  const file = normalize(join(root, decodeURIComponent(path)));
  const allowed = [join(root, 'src') + '/', join(root, 'examples') + '/'].some((dir) => file.startsWith(dir)) && file.endsWith('.ts');
  if (!allowed || !existsSync(file)) return false;
  const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  exchange.send(200, { 'content-type': 'text/javascript; charset=utf-8' }, new TextEncoder().encode(js));
  return true;
}

// certs/ (gitignored): a throwaway self-signed cert (valid for a day, renewed when it runs out), or
// bring your own (mkcert); a cert that isn't self-signed is never replaced.
const certDir = join(root, 'certs');
if (!existsSync(join(certDir, 'cert.pem')) || renewable(readFileSync(join(certDir, 'cert.pem')))) {
  const generated = testCert();
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, 'key.pem'), generated.key);
  writeFileSync(join(certDir, 'cert.pem'), generated.cert);
}
const key = readFileSync(join(certDir, 'key.pem'));
const cert = readFileSync(join(certDir, 'cert.pem'));
const server = createApueServer(todoApi, handlers, { key, cert, fallback: serveStatic });
if (process.env.APUE_DEBUG_STREAMS) {
  // The server's view of streams that did not end cleanly (the browser tests turn this on to
  // explain a rare net::ERR_FAILED for one module request in Chrome).
  server.server.on('stream', (stream, headers) => {
    stream.on('close', () => {
      // CANCEL (8) is how browsers end live streams and WebSockets (also before a stream committed its
      // headers); `writableFinished` is no signal (node:http2 closes a stream whose request body was
      // read without emitting 'finish'). Log other resets, and clean closes without a response.
      const status = stream.sentHeaders?.[':status'];
      if ((stream.rstCode !== 0 && stream.rstCode !== 8) || (stream.rstCode === 0 && status === undefined)) {
        console.error(`[stream] ${headers[':method']} ${headers[':path']} rst=${stream.rstCode} status=${status}`);
      }
    });
  });
  server.server.on('sessionError', (error) => console.error('[session error]', error.message));
}
const port = await server.listen(Number(process.env.PORT ?? 8443), process.env.HOST ?? '127.0.0.1');
console.log(`todo example on https://localhost:${port} (self-signed cert; use mkcert or accept it in the browser)`);
