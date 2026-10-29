import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Start a server that records HTTP requests and never responds to them.
 *
 * @example
 * const endpoint = await startSilentMcpHttpEndpoint();
 * await endpoint.stop();
 */
export async function startSilentMcpHttpEndpoint() {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request) => {
    requests.push(`${request.method} ${request.url}`);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
