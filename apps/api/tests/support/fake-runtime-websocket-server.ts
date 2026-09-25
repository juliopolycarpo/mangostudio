/**
 * A {@link FakeRuntimeDefinition} behind a real loopback WebSocket listener
 * that answers the way `mangostudio-runtime serve` does at its door: a bearer
 * token on the upgrade, the `mango.v1` subprotocol, one hub at a time.
 *
 * For hub tests about the Direct URL transport whose runtime side needs a
 * behaviour no real runtime can be given from a test (a scripted vendor
 * adapter, say). Tests about the listener itself drive the real binary's
 * `serve` instead (`rust-serve-dial.ts`).
 */

import { CLOSE_CODES, DEFAULT_MAX_MESSAGE_BYTES, type Session } from '@mangostudio/protocol';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
} from '@mangostudio/protocol/ws';
import { type FakeRuntimeDefinition, serveFakeRuntime } from './fake-runtime-host';

export interface FakeRuntimeWebSocketServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>`, the shape an `http` environment's `baseUrl` takes. */
  readonly baseUrl: string;
  /** Ends the live session, if any, and stops listening. */
  close(): Promise<void>;
}

interface SocketData {
  handle?: WebSocketPortHandle;
}

/**
 * Listens on an ephemeral loopback port and serves `definition` to a hub that
 * presents `Bearer <token>`; any other upgrade is refused with an empty 401
 * before it opens, as `serve` refuses it.
 *
 * @example
 * const server = serveFakeRuntimeOverWebSocket(definition, { token: 'secret' });
 * await connectHttpRuntime({ id, userId, config: { baseUrl: server.baseUrl } }, () => undefined);
 * await server.close();
 */
export function serveFakeRuntimeOverWebSocket(
  definition: FakeRuntimeDefinition,
  options: { readonly token: string }
): FakeRuntimeWebSocketServer {
  let active: Session | undefined;

  const server = Bun.serve<SocketData, never>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, self) {
      if (request.headers.get('authorization') !== `Bearer ${options.token}`) {
        return new Response(null, { status: 401 });
      }
      const offered = request.headers.get('sec-websocket-protocol') ?? '';
      const upgraded = self.upgrade(request, {
        data: {},
        ...(offered.split(',').some((value) => value.trim() === WEBSOCKET_SUBPROTOCOL)
          ? { headers: { 'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL } }
          : {}),
      });
      return upgraded ? undefined : new Response(null, { status: 500 });
    },
    websocket: {
      maxPayloadLength: DEFAULT_MAX_MESSAGE_BYTES,
      idleTimeout: 0,
      open(socket) {
        const handle = createWebSocketPort({
          send: (bytes) => outcomeOfBunSend(socket.send(bytes)),
          close: (code, reason) => socket.close(code, reason),
        });
        socket.data.handle = handle;
        active?.close(CLOSE_CODES.SUPERSEDED, 'Superseded');
        active = serveFakeRuntime(handle.port, definition, { livenessIntervalMs: false });
      },
      message(socket, message) {
        socket.data.handle?.onMessage(message);
      },
      drain(socket) {
        socket.data.handle?.onDrain();
      },
      close(socket, code, reason) {
        socket.data.handle?.onClose(code, reason);
      },
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error('expected a bound loopback port | received: none');
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      active?.close(CLOSE_CODES.RELEASED, 'Runtime stopped');
      await server.stop(true);
    },
  };
}
