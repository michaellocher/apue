// gRPC baseline server (TLS, HTTP/2), same data as the apü bench handlers. Prints {"grpc": port}.
//   node bench/grpc/server.ts --key key.pem --cert cert.pem
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { user } from '../api.ts';
import { grpc, proto } from './load.ts';

const { values } = parseArgs({ options: { key: { type: 'string' }, cert: { type: 'string' }, port: { type: 'string', default: '0' } } });
const server = new grpc.Server();
server.addService(proto.bench.Bench.service, {
  GetUser: (call: grpc.ServerUnaryCall<{ id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => callback(null, user(call.request.id)),
  Items: (call: grpc.ServerWritableStream<{ n: number }, unknown>) => {
    const n = call.request.n;
    let i = 0;
    // Respect backpressure like the apü writer does.
    const pump = () => {
      while (i < n) {
        if (!call.write({ i: i++, name: 'item', ok: true })) return void call.once('drain', pump);
      }
      call.end();
    };
    pump();
  },
});
const credentials = grpc.ServerCredentials.createSsl(null, [{ private_key: readFileSync(values.key!), cert_chain: readFileSync(values.cert!) }], false);
server.bindAsync(`127.0.0.1:${values.port}`, credentials, (error, port) => {
  if (error) throw error;
  process.stdout.write(JSON.stringify({ grpc: port }) + '\n');
});
process.on('SIGTERM', () => server.tryShutdown(() => process.exit(0)));
