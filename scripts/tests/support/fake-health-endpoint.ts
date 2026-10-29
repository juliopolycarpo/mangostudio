import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

type HealthBehavior = 'no-headers' | 'unavailable' | 'streaming-ready';

/** An owned HTTP endpoint that exposes stalled requests and open response bodies. */
export class FakeHealthEndpoint {
  private readonly sockets = new Set<Socket>();
  private readonly server: ReturnType<typeof createServer>;
  requests = 0;

  constructor(private readonly behavior: HealthBehavior) {
    this.server = createServer(this.respond);
  }

  private readonly respond = (_request: IncomingMessage, response: ServerResponse): void => {
    this.requests += 1;
    if (this.behavior === 'no-headers') return;
    if (this.behavior === 'unavailable') {
      response.writeHead(503).end('still starting');
      return;
    }
    response.writeHead(200);
    response.flushHeaders();
    response.write('ready response that never ends');
  };

  /** Listen on an OS-selected loopback port. @example const url = await endpoint.listen(); */
  async listen(): Promise<string> {
    this.server.on('connection', this.trackSocket);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error(`expected an owned TCP health endpoint | received: ${String(address)}`);
    }
    return `http://127.0.0.1:${address.port}/api/health`;
  }

  private readonly trackSocket = (socket: Socket): void => {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  };

  /** Await transport closure without hiding a leaked request. @example await endpoint.waitForNoSockets(); */
  async waitForNoSockets(): Promise<void> {
    const deadline = performance.now() + 500;
    while (this.sockets.size > 0 && performance.now() < deadline) await Bun.sleep(5);
    if (this.sockets.size > 0) {
      throw new Error(`expected no live health sockets | received: ${this.sockets.size}`);
    }
  }

  /** Close only this fixture's connections and listener. @example await endpoint.stop(); */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** Build a response whose headers survive a failed body. @example const response = erroredHealthResponse(200); */
export function erroredHealthResponse(status: number): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('health body failed after headers'));
    },
  });
  return new Response(body, { status });
}
