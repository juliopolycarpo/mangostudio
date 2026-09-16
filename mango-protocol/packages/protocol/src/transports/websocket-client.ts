/**
 * The two ways an application meets a WebSocket rather than a sink: wrap a
 * socket object that is already open, or dial one and wait for the upgrade.
 *
 * Both sit on `createWebSocketPort`, so the framing, the queue and the close
 * mapping are the same on a browser socket, a Bun socket and a server-side
 * client. Nothing here imports `node:`.
 */

import { CLOSE_CODES } from '../close';
import type { Port } from '../port';
import { abortReason, type ConnectDeadlineOptions, connectDeadline } from './deadline';
import {
  createWebSocketPort,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
  type WebSocketPortOptions,
} from './websocket';

/** `WebSocket.OPEN`: the only readyState a port may be built on. */
const WEBSOCKET_OPEN = 1;

/**
 * The part of the WHATWG `WebSocket` interface this transport uses. A browser
 * socket, a Bun socket and Node's `ws` all satisfy it.
 */
export interface WhatwgWebSocketLike {
  binaryType: string;
  readonly readyState: number;
  /** The subprotocol the acceptor selected; `mango.v1` for a Mango session. */
  readonly protocol: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { readonly code: number; readonly reason: string }) => void
  ): void;
  addEventListener(type: 'error' | 'open', listener: () => void): void;
}

/** How `connectWebSocket` dials, on top of how the port frames. */
export interface ConnectWebSocketOptions extends WebSocketPortOptions, ConnectDeadlineOptions {
  /**
   * Upgrade request headers, the place the reference bearer token goes.
   * Browsers and Node's global `WebSocket` cannot set them; see
   * `connectWebSocket`.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injected constructor, for tests and for runtimes without a global one. */
  readonly WebSocket?: new (
    url: string,
    options: {
      readonly protocols: readonly string[];
      readonly headers?: Readonly<Record<string, string>>;
    }
  ) => WhatwgWebSocketLike;
}

/**
 * Turns an already-open WebSocket into a `Port`. Call it in the same turn the
 * socket opened: a message that arrives before the listeners are attached is
 * gone, and the peer sends its `hello` the moment the socket is up.
 *
 * @example
 * server.on('connection', (socket) => new Session(webSocketPort(socket), { peer }));
 */
export function webSocketPort(
  socket: WhatwgWebSocketLike,
  options: WebSocketPortOptions = {}
): Port {
  if (socket.readyState !== WEBSOCKET_OPEN) {
    throw new Error(
      `WebSocket readyState is ${socket.readyState}; expected OPEN (${WEBSOCKET_OPEN}).`
    );
  }
  return attachWebSocketPort(socket, options).port;
}

/**
 * Dials `url`, offering the `mango.v1` subprotocol, and resolves with the port
 * once the socket is open and the acceptor selected that subprotocol.
 *
 * Only runtimes whose `WebSocket` takes an options object (Bun) can set
 * upgrade headers. In a browser, and on Node's global `WebSocket`, `headers`
 * is ignored: carry the token in the URL or in a cookie, whichever the
 * application prefers, or inject a constructor that supports headers.
 *
 * @example
 * const port = await connectWebSocket('wss://hub.example/runtime', {
 *   headers: { authorization: `Bearer ${token}` },
 * });
 * const session = new Session(port, { peer });
 */
export function connectWebSocket(
  url: string,
  options: ConnectWebSocketOptions = {}
): Promise<Port> {
  return new Promise<Port>((resolve, reject) => {
    const deadline = connectDeadline(url, options);
    const signal = deadline.signal;
    if (signal.aborted) {
      deadline.dispose();
      reject(abortReason(url, signal));
      return;
    }

    let socket: WhatwgWebSocketLike;
    try {
      socket = createSocket(url, options);
    } catch (cause) {
      deadline.dispose();
      reject(new Error(`WebSocket to ${url} could not be created: ${describe(cause)}`, { cause }));
      return;
    }

    const handle = attachWebSocketPort(socket, options);
    let settled = false;
    const finish = (settleWith: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      deadline.dispose();
      settleWith();
    };

    function onAbort(): void {
      finish(() => {
        socket.close(CLOSE_CODES.RELEASED, 'dial aborted');
        reject(abortReason(url, signal));
      });
    }
    signal.addEventListener('abort', onAbort, { once: true });

    socket.addEventListener('open', () => {
      if (socket.protocol !== WEBSOCKET_SUBPROTOCOL) {
        const selected = JSON.stringify(socket.protocol);
        finish(() => {
          socket.close(CLOSE_CODES.PROTOCOL_ERROR, 'subprotocol not selected');
          reject(
            new Error(
              `WebSocket at ${url} selected subprotocol ${selected}; expected ${JSON.stringify(WEBSOCKET_SUBPROTOCOL)}.`
            )
          );
        });
        return;
      }
      finish(() => resolve(handle.port));
    });

    socket.addEventListener('close', (event) => {
      const reason = event.reason === '' ? '' : `: ${event.reason}`;
      finish(() =>
        reject(
          new Error(`WebSocket to ${url} closed with code ${event.code}${reason} before it opened.`)
        )
      );
    });

    socket.addEventListener('error', () => {
      finish(() => reject(new Error(`WebSocket to ${url} failed before it opened.`)));
    });
  });
}

/** Sets `binaryType`, builds the port over the socket, and wires the socket's events to it. */
function attachWebSocketPort(
  socket: WhatwgWebSocketLike,
  options: WebSocketPortOptions
): WebSocketPortHandle {
  socket.binaryType = 'arraybuffer';
  const handle = createWebSocketPort(
    {
      send: (message) => {
        socket.send(message);
      },
      close: (code, reason) => socket.close(code, reason),
    },
    options
  );
  socket.addEventListener('message', (event) => deliver(handle, event.data));
  socket.addEventListener('close', (event) => handle.onClose(event.code, event.reason));
  socket.addEventListener('error', () =>
    handle.onError(new Error('the WebSocket reported an error; expected it to stay open'))
  );
  return handle;
}

/** Normalises whatever the runtime puts in `event.data` into what the port accepts. */
function deliver(handle: WebSocketPortHandle, data: unknown): void {
  if (typeof data === 'string' || data instanceof ArrayBuffer) {
    handle.onMessage(data);
    return;
  }
  if (ArrayBuffer.isView(data)) {
    handle.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return;
  }
  handle.onError(
    new TypeError(
      `WebSocket message data is ${describe(data)}; expected a string, an ArrayBuffer or a typed array`
    )
  );
}

/** Bun's global `WebSocket` takes `{ protocols, headers }`; the browser's takes the list. */
function acceptsSocketOptions(): boolean {
  return 'Bun' in globalThis;
}

/** The second argument a runtime whose `WebSocket` takes an options object expects. */
interface SocketSettings {
  readonly protocols: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

function createSocket(url: string, options: ConnectWebSocketOptions): WhatwgWebSocketLike {
  const settings: SocketSettings = {
    protocols: [WEBSOCKET_SUBPROTOCOL],
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  };
  const injected = options.WebSocket;
  if (injected !== undefined) return new injected(url, settings);

  const globalConstructor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof globalConstructor !== 'function') {
    throw new TypeError(
      `globalThis.WebSocket is ${describe(globalConstructor)}; expected a WebSocket constructor, or one passed as options.WebSocket`
    );
  }
  if (acceptsSocketOptions()) {
    const withOptions = globalConstructor as unknown as new (
      url: string,
      settings: SocketSettings
    ) => WhatwgWebSocketLike;
    return new withOptions(url, settings);
  }
  const withProtocols = globalConstructor as unknown as new (
    url: string,
    protocols: readonly string[]
  ) => WhatwgWebSocketLike;
  return new withProtocols(url, settings.protocols);
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value === null) return 'null';
  if (typeof value === 'object') return value.constructor?.name ?? 'an object';
  return typeof value;
}
