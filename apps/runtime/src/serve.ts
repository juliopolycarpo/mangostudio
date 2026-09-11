/**
 * The listen half of a Direct URL runtime: the hub dials in over WebSocket,
 * authenticated by a bearer token this process holds.
 *
 * The socket carries wire 1.0 under the `mango.v1` subprotocol, so a hub cannot
 * tell serve from dial-in once the upgrade completes. A hub that offers no
 * subprotocol still gets its socket: it is an older release, and letting it
 * speak is what lets the session answer its hello with close 4426 instead of a
 * bare HTTP refusal it has no vocabulary for.
 *
 * One hub connection at a time. A new upgrade supersedes the previous one, and
 * the replacement does not announce itself until the superseded definition has
 * released its terminals and child processes.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  CLOSE_CODES,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  type Session,
} from '@mangostudio/protocol';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
} from '@mangostudio/protocol/ws';
import { RUNTIME_HEARTBEAT_TOPIC } from '@mangostudio/shared/runtime-contract';
import { getRuntimeVersion } from './config';
import { createRuntimeSession, type RuntimeHostDefinition, whenRuntimeReleased } from './session';

const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Well under a typical reverse-proxy idle timeout, in both directions. */
const LIVENESS_INTERVAL_MS = 20_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface RuntimeServeListen {
  readonly hostname: string;
  readonly port: number;
}

export interface RuntimeServeOptions {
  readonly listen: RuntimeServeListen;
  readonly token: string;
  /** Built once per hub connection; the session releases it when the socket ends. */
  readonly createHost: () => RuntimeHostDefinition;
  /** Diagnostics; the protocol itself never writes here. */
  readonly log?: (message: string) => void;
  /** Stops the server. A signal handler aborts it. */
  readonly signal?: AbortSignal;
}

export interface RuntimeServeHandle {
  readonly hostname: string;
  readonly port: number;
  /** Resolves after the server stops accepting and the last definition finishes cleanup. */
  readonly stopped: Promise<void>;
  /** Stops accepting connections after all session-owned resources are reaped. */
  close(): Promise<void>;
}

/**
 * One upgraded socket.
 *
 * `session` is absent for as long as the previous connection is still releasing
 * its resources: the port exists from the moment the socket opens — it has to,
 * or the hub's `hello` is lost — while the session that answers it is built
 * only once this connection owns the runtime.
 */
interface ActiveConnection {
  readonly generation: number;
  readonly handle: WebSocketPortHandle;
  session?: Session;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface ServeSocketData {
  generation: number;
  handle?: WebSocketPortHandle;
}

/**
 * Parses `--listen` values: a bare port binds loopback, `host:port` binds that
 * host. Port `0` is allowed so tests can take an ephemeral port.
 */
export function parseListenAddress(value: string): RuntimeServeListen | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
    return { hostname: '127.0.0.1', port };
  }

  const separator = trimmed.lastIndexOf(':');
  if (separator <= 0) return null;
  const hostname = trimmed.slice(0, separator).trim();
  const portText = trimmed.slice(separator + 1).trim();
  if (!hostname || !/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
  return { hostname, port };
}

/** True for addresses that never leave this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  );
}

export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

/** Constant-time equality for bearer credentials of equal length. */
export function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Listens for one hub at a time. Resolves a handle as soon as the socket is
 * bound; the caller awaits `stopped` (or aborts the signal) to wait out the
 * process lifetime.
 */
export function serveRuntime(options: RuntimeServeOptions): RuntimeServeHandle {
  const log = options.log ?? (() => undefined);
  const version = getRuntimeVersion();
  let active: ActiveConnection | null = null;
  let generation = 0;
  let closed = false;
  const pendingTeardowns = new Set<Promise<void>>();
  let openCallbacks = 0;
  const openCallbackWaiters = new Set<() => void>();

  const stopped = Promise.withResolvers<void>();
  // The abort listener and the already-aborted call below both discard the
  // returned promise. One attached handler keeps an unexpected teardown failure
  // from surfacing as a process-level unhandled rejection; callers that await
  // `stopped` or `close()` still observe it.
  void stopped.promise.catch(() => undefined);

  /**
   * Ends one connection and waits for whatever it holds open.
   *
   * Idempotent, and safe on a connection whose session does not exist yet: the
   * definition is built after the port, so an early stop closes the port and
   * the `open` callback releases the session it went on to build.
   */
  const releaseConnection = (
    entry: ActiveConnection,
    code: number,
    reason: string
  ): Promise<void> => {
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    entry.heartbeat = undefined;
    const session = entry.session;
    if (!session) {
      entry.handle.port.close(code, reason);
      return Promise.resolve();
    }
    session.close(code, reason);
    const released = whenRuntimeReleased(session);
    pendingTeardowns.add(released);
    void released.then(() => pendingTeardowns.delete(released));
    return released;
  };

  const waitForOpenCallbacks = (): Promise<void> => {
    if (openCallbacks === 0) return Promise.resolve();
    return new Promise((resolve) => openCallbackWaiters.add(resolve));
  };

  /** Runs one upgraded socket from the port it needs to `hello` acknowledged. */
  const accept = async (socket: ServeSocket): Promise<void> => {
    const handle = createWebSocketPort({
      send: (bytes) => outcomeOfBunSend(socket.send(bytes)),
      close: (code, reason) => socket.close(code, reason),
    });
    socket.data.handle = handle;
    if (closed) {
      handle.port.close(CLOSE_CODES.RELEASED, 'Runtime stopped');
      return;
    }

    const previous = active;
    const mine = ++generation;
    socket.data.generation = mine;
    const entry: ActiveConnection = { generation: mine, handle };
    active = entry;

    if (previous) {
      await releaseConnection(previous, CLOSE_CODES.SUPERSEDED, 'Superseded');
      log('A new hub connection superseded the previous one.');
    }
    // A newer connection or a stop can win while an older definition is still
    // releasing. Never build a session for a connection that ceased to be the
    // active generation while it waited.
    if (closed || active?.generation !== mine) {
      handle.port.close(CLOSE_CODES.RELEASED, 'Runtime stopped');
      return;
    }

    entry.session = createRuntimeSession(handle.port, options.createHost(), {
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      livenessIntervalMs: LIVENESS_INTERVAL_MS,
    });
    if (closed || active?.generation !== mine) {
      await releaseConnection(entry, CLOSE_CODES.RELEASED, 'Runtime stopped');
      return;
    }

    try {
      await entry.session.ready;
    } catch (error) {
      log(`Handshake failed: ${asError(error).message}`);
      if (active?.generation === mine) active = null;
      await releaseConnection(entry, CLOSE_CODES.RELEASED, 'Handshake failed');
      return;
    }
    if (active?.generation !== mine) return;

    // No immediate beat: an early heartbeat would consume seq 0 on the topic
    // before a freshly connected hub had a chance to observe it, and the
    // interval is already short enough for card freshness.
    entry.heartbeat = setInterval(() => {
      entry.session?.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: Date.now() } });
    }, HEARTBEAT_INTERVAL_MS);
    (entry.heartbeat as { unref?: () => void }).unref?.();
    log('Hub connected.');
  };

  const server = Bun.serve<ServeSocketData, never>({
    hostname: options.listen.hostname,
    port: options.listen.port,
    fetch(request, self) {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok', version });
      }
      if (path !== '/') {
        return new Response(null, { status: 404 });
      }
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response(null, { status: 400 });
      }

      const presented = bearerToken(request.headers.get('authorization'));
      if (!presented || !tokensEqual(presented, options.token)) {
        // Empty body on purpose: do not say whether the header was missing or wrong.
        return new Response(null, { status: 401 });
      }

      const upgraded = self.upgrade(request, {
        data: { generation: 0 },
        ...(offersMangoSubprotocol(request)
          ? { headers: { 'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL } }
          : {}),
      });
      if (upgraded) return undefined;
      return new Response(null, { status: 500 });
    },
    websocket: {
      maxPayloadLength: DEFAULT_MAX_MESSAGE_BYTES,
      // Match the port's own queue budget so a slow hub drains through
      // backpressure instead of Bun closing the socket first.
      backpressureLimit: DEFAULT_MAX_FRAME_BYTES,
      closeOnBackpressureLimit: true,
      idleTimeout: 0,
      async open(socket) {
        openCallbacks += 1;
        try {
          await accept(socket);
        } finally {
          openCallbacks -= 1;
          if (openCallbacks === 0) {
            for (const resolve of [...openCallbackWaiters]) resolve();
            openCallbackWaiters.clear();
          }
        }
      },
      message(socket, message) {
        socket.data.handle?.onMessage(message);
      },
      drain(socket) {
        socket.data.handle?.onDrain();
      },
      async close(socket, code, reason) {
        socket.data.handle?.onClose(code, reason);
        if (active?.generation !== socket.data.generation) return;
        const entry = active;
        active = null;
        await releaseConnection(entry, CLOSE_CODES.RELEASED, 'Socket closed');
      },
    },
  });

  const stop = (): Promise<void> => {
    if (closed) return stopped.promise;
    closed = true;
    const entry = active;
    active = null;
    const activeTeardown = entry
      ? releaseConnection(entry, CLOSE_CODES.RELEASED, 'Runtime stopped')
      : Promise.resolve();
    server.stop(true);
    void (async () => {
      await activeTeardown;
      await waitForOpenCallbacks();
      while (pendingTeardowns.size > 0) {
        await Promise.all([...pendingTeardowns]);
      }
    })().then(stopped.resolve, stopped.reject);
    return stopped.promise;
  };

  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error('The runtime serve socket did not bind a port.');
  }

  // Honor a signal that fired before we subscribed — otherwise a caller that
  // aborts during construction leaves a listening socket behind.
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) {
    stop();
  }

  const bind = `${options.listen.hostname}:${port}`;
  if (!isLoopbackHostname(options.listen.hostname)) {
    log(`Listening on ${bind}. Whoever holds the serve token gets shell access on this machine.`);
  } else {
    log(`Listening on ${bind}.`);
  }

  return {
    hostname: options.listen.hostname,
    port,
    stopped: stopped.promise,
    close: stop,
  };
}

/**
 * True when the upgrade request offered `mango.v1`.
 *
 * An acceptor may only select a subprotocol the dialler listed, so a hub that
 * offered none gets none echoed back — selecting one anyway is what a WHATWG
 * client fails the connection on, and a 1.0.1 hub offers none.
 */
function offersMangoSubprotocol(request: Request): boolean {
  const offered = request.headers.get('sec-websocket-protocol') ?? '';
  return offered.split(',').some((protocol) => protocol.trim() === WEBSOCKET_SUBPROTOCOL);
}

/** The half of Bun's `ServerWebSocket` this module drives. */
interface ServeSocket {
  readonly data: ServeSocketData;
  send(message: Uint8Array): number;
  close(code?: number, reason?: string): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
