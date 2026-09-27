/**
 * Test-process half of the MCP relay fixture: real SDK `Server`s living in the test process,
 * reachable by any runtime as ordinary stdio MCP servers. A route hands back the stdio launch a
 * server row stores; when a runtime spawns it, `mcp-stdio-relay.ts` dials this host over a
 * loopback WebSocket (ephemeral port) and the route's factory builds a fresh `Server` for that
 * session — so a reconnect gets a live server, and closing a `Server` ends the child process the
 * runtime is holding, exactly as a crashing server would.
 *
 * Only the byte pipe is borrowed; the runtime spawns a real process, speaks real stdio, and runs
 * its own SDK client, which is what makes the fixture valid for every runtime implementation.
 */

import { fileURLToPath } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerWebSocket } from 'bun';

const RELAY_SCRIPT = fileURLToPath(new URL('./mcp-stdio-relay.ts', import.meta.url));

/** Bound on waiting for runtimes to release their sessions during `close()`. */
const TEARDOWN_WAIT_MS = 5_000;

/** The stdio launch a server row stores so a runtime spawns the relay for one route. */
export interface McpStdioLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface McpRelayHost {
  /**
   * Registers a server factory and returns the launch that reaches it. Every spawn of that
   * launch gets its own `createServer()` instance.
   */
  route(createServer: () => Server): McpStdioLaunch;
  /** Servers whose session is still open, i.e. whose relay child is still connected. */
  readonly openServers: number;
  /** Resolves once no session is open; rejects with the open count after `timeoutMs`. */
  waitForNoOpenServers(timeoutMs?: number): Promise<void>;
  /**
   * Waits (bounded) for runtimes to release every session, force-closes any that remain, and
   * stops the host. Sessions that had to be forced are what `assertNoOpenServers` reports.
   */
  close(): Promise<void>;
  /** Throws when a session outlived its runtime's teardown. */
  assertNoOpenServers(): void;
}

interface SocketData {
  readonly route: string;
  transport?: RelayServerTransport;
}

/** SDK transport over one relay WebSocket; messages are JSON-RPC, one per frame. */
class RelayServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #started = false;
  #closed = false;
  readonly #queued: JSONRPCMessage[] = [];

  constructor(private readonly socket: ServerWebSocket<SocketData>) {}

  start(): Promise<void> {
    this.#started = true;
    for (const message of this.#queued.splice(0)) this.onmessage?.(message);
    return Promise.resolve();
  }

  /** Feeds one frame the relay child read from the runtime. */
  receive(frame: string): void {
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(frame));
    } catch (error) {
      this.onerror?.(
        new Error(`expected a JSON-RPC message frame | received ${frame.slice(0, 200)}`, {
          cause: error,
        })
      );
      return;
    }
    if (!this.#started) {
      this.#queued.push(message);
      return;
    }
    this.onmessage?.(message);
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new Error('expected an open relay session | received a send after close')
      );
    }
    this.socket.send(JSON.stringify(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.socket.close();
      this.peerClosed();
    }
    return Promise.resolve();
  }

  /** The relay child went away (runtime closed the session, or the process died). */
  peerClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
}

/**
 * Starts a relay host on an ephemeral loopback port.
 *
 * @example
 * const host = await startMcpRelayHost();
 * const launch = host.route(createEchoMcpServer);
 * // store launch.command / launch.args on a stdio server row, run the test, then:
 * await host.close();
 * host.assertNoOpenServers();
 */
export function startMcpRelayHost(): Promise<McpRelayHost> {
  const routes = new Map<string, () => Server>();
  const open = new Set<Server>();
  const drainWaiters = new Set<() => void>();
  let forced = 0;

  const forget = (server: Server) => {
    open.delete(server);
    if (open.size > 0) return;
    for (const notify of drainWaiters) notify();
  };

  const host = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const route = new URL(request.url).pathname.slice(1);
      if (!routes.has(route)) {
        return new Response(
          `expected a registered relay route (${[...routes.keys()].join(', ')}) | received "${route}"`,
          { status: 404 }
        );
      }
      if (server.upgrade(request, { data: { route } })) return undefined;
      return new Response('expected a WebSocket upgrade | received a plain request', {
        status: 400,
      });
    },
    websocket: {
      open(socket) {
        const createServer = routes.get(socket.data.route);
        if (!createServer) {
          socket.close();
          return;
        }
        const transport = new RelayServerTransport(socket);
        socket.data.transport = transport;
        const server = createServer();
        const previousOnClose = server.onclose;
        server.onclose = () => {
          forget(server);
          previousOnClose?.();
        };
        open.add(server);
        void server.connect(transport);
      },
      message(socket, frame) {
        socket.data.transport?.receive(String(frame));
      },
      close(socket) {
        socket.data.transport?.peerClosed();
      },
    },
  });

  const waitForNoOpenServers = (timeoutMs = TEARDOWN_WAIT_MS) =>
    new Promise<void>((resolve, reject) => {
      if (open.size === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        drainWaiters.delete(notify);
        reject(
          new Error(
            `expected every relay MCP session to close within ${timeoutMs} ms | received ${open.size} still open`
          )
        );
      }, timeoutMs);
      const notify = () => {
        clearTimeout(timer);
        drainWaiters.delete(notify);
        resolve();
      };
      drainWaiters.add(notify);
    });

  return Promise.resolve({
    route(createServer) {
      const route = `route-${routes.size + 1}`;
      routes.set(route, createServer);
      return {
        command: process.execPath,
        args: [RELAY_SCRIPT, `ws://127.0.0.1:${host.port}/${route}`],
      };
    },
    get openServers() {
      return open.size;
    },
    waitForNoOpenServers,
    async close() {
      await waitForNoOpenServers().catch(() => undefined);
      forced += open.size;
      await Promise.allSettled([...open].map((server) => server.close()));
      await host.stop(true);
    },
    assertNoOpenServers() {
      if (forced > 0 || open.size > 0) {
        throw new Error(
          `expected runtimes to release every relay MCP session | received ${forced + open.size} left open`
        );
      }
    },
  });
}
