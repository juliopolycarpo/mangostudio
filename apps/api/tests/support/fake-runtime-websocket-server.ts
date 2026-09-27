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
  /** The upgrade carried a wrong token and is refused once open. */
  refused?: boolean;
}

/** The close code and reason `serve` uses for a credential it refuses after the upgrade. */
const CREDENTIAL_REFUSED = { code: 4401, reason: 'credential refused' } as const;

export interface FakeRuntimeWebSocketServerOptions {
  readonly token: string;
  /**
   * How a wrong token is refused: `before-upgrade` (default) answers an empty
   * 401 so the socket never opens; `after-upgrade` completes the upgrade and
   * closes with 4401, which is what the Rust `serve` does.
   */
  readonly refuse?: 'before-upgrade' | 'after-upgrade';
}

/**
 * Listens on an ephemeral loopback port and serves `definition` to a hub that
 * presents `Bearer <token>`; any other upgrade is refused either with an empty
 * 401 before it opens or with a 4401 close after it, per `options.refuse`.
 *
 * @example
 * const server = serveFakeRuntimeOverWebSocket(definition, { token: 'secret' });
 * await connectHttpRuntime({ id, userId, config: { baseUrl: server.baseUrl } }, () => undefined);
 * await server.close();
 */
export function serveFakeRuntimeOverWebSocket(
  definition: FakeRuntimeDefinition,
  options: FakeRuntimeWebSocketServerOptions
): FakeRuntimeWebSocketServer {
  let active: Session | undefined;

  const server = Bun.serve<SocketData, never>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, self) {
      const refused = request.headers.get('authorization') !== `Bearer ${options.token}`;
      if (refused && options.refuse !== 'after-upgrade') {
        return new Response(null, { status: 401 });
      }
      const offered = request.headers.get('sec-websocket-protocol') ?? '';
      const upgraded = self.upgrade(request, {
        data: { refused },
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
        if (socket.data.refused) {
          socket.close(CREDENTIAL_REFUSED.code, CREDENTIAL_REFUSED.reason);
          return;
        }
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
