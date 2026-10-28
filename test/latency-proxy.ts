// TCP proxy that delays every chunk by a fixed one-way latency (order preserved; no bandwidth cap):
// emulates RTT for flow-control tests without Docker/netem.
import net from 'node:net';

export async function latencyProxy(targetPort: number, oneWayMs: number): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const delayed = (from: net.Socket, to: net.Socket) => {
    from.on('data', (chunk) => setTimeout(() => !to.destroyed && to.write(chunk), oneWayMs));
    from.on('end', () => setTimeout(() => to.end(), oneWayMs));
    from.on('error', () => to.destroy());
    from.on('close', () => setTimeout(() => to.destroy(), oneWayMs + 5));
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const s of [client, upstream]) (sockets.add(s), s.on('close', () => sockets.delete(s)), s.setNoDelay(true));
    delayed(client, upstream);
    delayed(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
