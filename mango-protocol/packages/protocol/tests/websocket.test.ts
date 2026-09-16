import { describe, expect, it } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { CLOSE_CODES } from '../src/close';
import { CHUNK_HEADER_BYTES } from '../src/codec/chunk';
import { Session, type SessionOptions } from '../src/session';
import {
  CONFORMANCE_A,
  CONFORMANCE_HANDLERS,
  type ConformanceFixture,
  itBehavesLikeAMangoTransport,
} from '../src/testing/conformance';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
  type WebSocketPortOptions,
  type WebSocketSink,
} from '../src/transports/websocket';
import { connectWebSocket, type WhatwgWebSocketLike } from '../src/transports/websocket-client';

const HOST = '127.0.0.1';
const BEARER = 'Bearer test-token';

/** What the upgrade hands to the socket handlers: the port built for it. */
interface SocketData {
  handle: WebSocketPortHandle | undefined;
}

/** A Bun `Bun.serve` that runs session `a` for the one connection a test makes. */
class MangoWebSocketServer {
  readonly #server: Server<SocketData>;
  readonly #ready = deferred<Session>();
  #socket: ServerWebSocket<SocketData> | undefined;

  constructor(aOptions: SessionOptions, portOptions: WebSocketPortOptions) {
    const ready = this.#ready;
    const accept = (socket: ServerWebSocket<SocketData>): void => {
      this.#socket = socket;
    };
    this.#server = Bun.serve<SocketData>({
      hostname: HOST,
      port: 0,
      fetch(request, server) {
        const refusal = refuseUpgrade(request);
        if (refusal !== undefined) return refusal;
        const upgraded = server.upgrade(request, {
          data: { handle: undefined },
          headers: { 'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL },
        });
        return upgraded
          ? undefined
          : new Response('expected a WebSocket upgrade request', { status: 426 });
      },
      websocket: {
        open(socket) {
          accept(socket);
          const handle = createWebSocketPort(sinkFor(socket), portOptions);
          socket.data.handle = handle;
          ready.resolve(new Session(handle.port, aOptions));
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
  }

  get url(): string {
    return `ws://${HOST}:${this.#server.port}`;
  }

  get origin(): string {
    return `http://${HOST}:${this.#server.port}`;
  }

  /** The session this side runs, once the socket is up. */
  get session(): Promise<Session> {
    return this.#ready.promise;
  }

  /** Severs the link the way a crash would: no close frame, no reason code. */
  sever(): void {
    this.#socket?.terminate();
  }

  stop(): Promise<void> {
    return this.#server.stop(true);
  }
}

/** The reference bearer check and subprotocol check of the transport spec. */
function refuseUpgrade(request: Request): Response | undefined {
  if (request.headers.get('authorization') !== BEARER) {
    return new Response('expected Authorization: Bearer <token>', { status: 401 });
  }
  const offered = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim());
  if (!offered.includes(WEBSOCKET_SUBPROTOCOL)) {
    return new Response(`expected the ${WEBSOCKET_SUBPROTOCOL} subprotocol`, { status: 426 });
  }
  return undefined;
}

/** The sink pattern the adoption guide documents, over a Bun server socket. */
function sinkFor(socket: ServerWebSocket<SocketData>): WebSocketSink {
  return {
    send: (message) => outcomeOfBunSend(socket.send(message)),
    close: (code, reason) => socket.close(code, reason),
  };
}

function fixture(portOptions: WebSocketPortOptions): ConformanceFixture {
  return {
    chunked: true,

    async connect(aOptions: SessionOptions, bOptions: SessionOptions) {
      const server = new MangoWebSocketServer(aOptions, portOptions);
      const port = await connectWebSocket(server.url, {
        ...portOptions,
        headers: { authorization: BEARER },
      });
      // The acceptor's hello was already on the wire when the socket opened;
      // the port holds it until the session subscribes.
      const b = new Session(port, bOptions);
      const a = await server.session;
      // A real link needs a round trip for the hellos, and `emit` is a no-op
      // until a session is ready. `allSettled` also lets the major-mismatch
      // case through, where both handshakes fail on purpose.
      await Promise.allSettled([a.ready, b.ready]);
      return {
        a,
        b,
        drop: () => server.sever(),
        close: async () => {
          a.close();
          b.close();
          await server.stop();
        },
      };
    },

    async connectRaw(aOptions: SessionOptions) {
      const server = new MangoWebSocketServer(aOptions, portOptions);
      const raw = await openRawSocket(server.url);
      const a = await server.session;
      return {
        a,
        write: (line: string) => raw.send(chunkOf(line)),
        close: async () => {
          raw.close(CLOSE_CODES.RELEASED, 'raw peer done');
          a.close();
          await server.stop();
        },
      };
    },
  };
}

describe('websocket transport (2048-byte message ceiling)', () => {
  itBehavesLikeAMangoTransport(fixture({ maxMessageBytes: 2048 }));
});

describe('websocket transport (default message ceiling)', () => {
  itBehavesLikeAMangoTransport(fixture({}));
});

describe('websocket transport upgrade and framing', () => {
  it('closes the port with 4400 when a raw peer sends a text message', async () => {
    const server = new MangoWebSocketServer(sessionOptions(), {});
    const raw = await openRawSocket(server.url);
    const rawClosed = new Promise<number>((resolve) => {
      raw.addEventListener('close', (event) => resolve(event.code));
    });
    const a = await server.session;
    const closed = new Promise((resolve) => a.onClose(resolve));

    raw.send('{"type":"ping"}');

    expect(await closed).toMatchObject({ code: CLOSE_CODES.PROTOCOL_ERROR });
    expect(a.closure?.error?.kind).toBe('schema');
    expect(await rawClosed).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    await server.stop();
  });

  it('refuses an upgrade that does not offer the mango.v1 subprotocol', async () => {
    const server = new MangoWebSocketServer(sessionOptions(), {});

    const response = await fetch(server.origin, { headers: { authorization: BEARER } });

    expect(response.status).toBe(426);
    expect(await response.text()).toBe(`expected the ${WEBSOCKET_SUBPROTOCOL} subprotocol`);
    await server.stop();
  });

  it('refuses an upgrade whose bearer token is wrong', async () => {
    const server = new MangoWebSocketServer(sessionOptions(), {});

    const response = await fetch(server.origin, {
      headers: { authorization: 'Bearer wrong-token', 'sec-websocket-protocol': 'mango.v1' },
    });

    expect(response.status).toBe(401);
    await expect(
      connectWebSocket(server.url, { headers: { authorization: 'Bearer wrong-token' } })
    ).rejects.toThrow(/before it opened/);
    await server.stop();
  });

  it('rejects the dial when the acceptor selects no subprotocol', async () => {
    await expect(
      connectWebSocket('ws://example.invalid/hub', { WebSocket: SilentUpgradeWebSocket })
    ).rejects.toThrow(/selected subprotocol ""; expected "mango.v1"/);
  });

  it('rejects the dial when the socket closes before it ever opened', async () => {
    // A dial the acceptor hangs up on settles on the close event alone: no
    // `open` and no `error` follow it, so a promise that waited for one of
    // those would stay pending for the lifetime of the process.
    await expect(
      connectWebSocket('ws://example.invalid/hub', { WebSocket: ClosedBeforeOpenWebSocket })
    ).rejects.toThrow(
      'WebSocket to ws://example.invalid/hub closed with code 1006: the acceptor hung up before it opened.'
    );
  });

  it('abandons a dial when the signal aborts, and closes the socket', async () => {
    const sockets: StalledWebSocket[] = [];
    const controller = new AbortController();
    const dial = connectWebSocket('ws://example.invalid/hub', {
      signal: controller.signal,
      WebSocket: class extends StalledWebSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    });

    controller.abort();

    await expect(dial).rejects.toMatchObject({ name: 'AbortError' });
    expect(sockets[0]?.closes).toEqual([CLOSE_CODES.RELEASED]);
  });

  it('abandons a dial that never opens once the deadline passes', async () => {
    const sockets: StalledWebSocket[] = [];
    const dial = connectWebSocket('ws://example.invalid/hub', {
      timeoutMs: 30,
      WebSocket: class extends StalledWebSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    });

    await expect(dial).rejects.toMatchObject({
      name: 'TimeoutError',
      message:
        'The connection to ws://example.invalid/hub timed out after 30 ms; expected the peer to accept it.',
    });
    expect(sockets[0]?.closes).toEqual([CLOSE_CODES.RELEASED]);
  });

  it('refuses a deadline that is not a positive number of milliseconds', async () => {
    await expect(
      connectWebSocket('ws://example.invalid/hub', {
        timeoutMs: Number.POSITIVE_INFINITY,
        WebSocket: StalledWebSocket,
      })
    ).rejects.toThrow(
      'timeoutMs is Infinity; expected a positive finite number of milliseconds, or none for no deadline'
    );
  });

  it('refuses a dial whose signal has already aborted', async () => {
    await expect(
      connectWebSocket('ws://example.invalid/hub', {
        signal: AbortSignal.abort(new Error('gone before we dialled')),
        WebSocket: StalledWebSocket,
      })
    ).rejects.toThrow('gone before we dialled');
  });
});

/** A socket that never opens, so a dial stays in flight until something stops it. */
class StalledWebSocket implements WhatwgWebSocketLike {
  binaryType = 'blob';
  readonly readyState = 0;
  readonly protocol = '';
  readonly closes: number[] = [];

  constructor(readonly url: string) {}

  send(_data: Uint8Array): void {
    throw new Error('StalledWebSocket never opens; expected no send.');
  }

  close(code?: number): void {
    this.closes.push(code ?? 1000);
  }

  addEventListener(_type: string, _listener: (event: never) => void): void {
    // A stalled socket fires nothing; the test drives the signal instead.
  }
}

/** A socket the acceptor hangs up on: `close` arrives and `open` never does. */
class ClosedBeforeOpenWebSocket implements WhatwgWebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  readonly protocol = '';
  readonly #listeners = new Map<string, ((event: never) => void)[]>();

  constructor(_url: string, _settings: { readonly protocols: readonly string[] }) {
    queueMicrotask(() => {
      this.readyState = 3;
      const event = { code: 1006, reason: 'the acceptor hung up' };
      for (const listener of this.#listeners.get('close') ?? []) listener(event as never);
    });
  }

  send(_data: Uint8Array): void {
    throw new Error('ClosedBeforeOpenWebSocket never opens; expected no send.');
  }

  close(code?: number): void {
    throw new Error(`ClosedBeforeOpenWebSocket is already closed; expected no close(${code}).`);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }
}

/** A socket that opens without echoing the subprotocol, as a lax acceptor would. */
class SilentUpgradeWebSocket implements WhatwgWebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  readonly protocol = '';
  readonly closes: number[] = [];
  readonly #listeners = new Map<string, (() => void)[]>();

  constructor(_url: string, _settings: { readonly protocols: readonly string[] }) {
    queueMicrotask(() => {
      this.readyState = 1;
      for (const listener of this.#listeners.get('open') ?? []) listener();
    });
  }

  send(_data: Uint8Array): void {
    throw new Error('SilentUpgradeWebSocket never carries a frame; expected no send.');
  }

  close(code?: number): void {
    this.readyState = 3;
    this.closes.push(code ?? 1000);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener as () => void);
    this.#listeners.set(type, listeners);
  }
}

function sessionOptions(): SessionOptions {
  return { peer: CONFORMANCE_A, handlers: CONFORMANCE_HANDLERS, livenessIntervalMs: false };
}

/** A plain Bun client socket, so a test can put arbitrary bytes on the wire. */
function openRawSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      protocols: [WEBSOCKET_SUBPROTOCOL],
      headers: { authorization: BEARER },
    });
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', () =>
      reject(new Error(`the raw socket to ${url} failed to open; expected an upgrade`))
    );
  });
}

/** One NDJSON line as a single chunk: version 1, index 0, count 1. */
function chunkOf(line: string): Uint8Array {
  const payload = new TextEncoder().encode(line.endsWith('\n') ? line.slice(0, -1) : line);
  const message = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(message.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 0);
  view.setUint32(5, 1);
  message.set(payload, CHUNK_HEADER_BYTES);
  return message;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  if (resolve === undefined) {
    throw new Error('the promise executor did not run synchronously; expected a resolve function');
  }
  return { promise, resolve };
}
