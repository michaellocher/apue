// Loads the bench proto with @grpc/proto-loader (dev dependency; benchmarks only).
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';

const definition = protoLoader.loadSync(join(import.meta.dirname, 'bench.proto'), { keepCase: true, longs: Number, defaults: true });
export const proto = grpc.loadPackageDefinition(definition) as unknown as {
  bench: { Bench: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition } };
};
export { grpc };
