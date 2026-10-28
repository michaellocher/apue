// server.ts — node server.ts
import { readFileSync } from 'node:fs';
import { createApueServer, type Handlers } from '../../src/server.ts';
import { api } from './api.ts';

const handlers: Handlers<typeof api> = {
  'greetings.get': ({ name }) => ({ text: `Hello, ${name}!` }),
  'greetings.count': async function* ({ to }, ctx) {
    for (let n = 1; n <= to && !ctx.signal.aborted; n++) {
      yield { n };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  },
};

const server = createApueServer(api, handlers, {
  key: readFileSync('certs/key.pem'),
  cert: readFileSync('certs/cert.pem'),
});
const port = await server.listen(Number(process.env.PORT ?? 8443), '127.0.0.1');
console.log(`listening on https://localhost:${port}`);
