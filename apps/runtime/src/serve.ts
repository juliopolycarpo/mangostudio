/**
 * The listen half of a Direct URL runtime: the hub dials in over WebSocket,
 * authenticated by a bearer token this process holds.
 *
 * Framing matches the paired WebSocket transport — mandatory chunking at the
 * shared 16 KiB ceiling — so a hub client cannot tell serve from dial-in once
 * the socket is open. One hub connection at a time: a new upgrade supersedes
 * the previous one rather than serving both.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  RUNTIME_CLOSE_CODES,
  RUNTIME_HEARTBEAT_TOPIC,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
} from '@mangostudio/shared/runtime-protocol';
import { getRuntimeVersion } from './config';
import type { RuntimeHost } from './host';
import { startProtocolLiveness } from './liveness';
import {
  createWebSocketFramePort,
  type ServerWebSocketLike,
  serverWebSocketSink,
  type WebSocketFramePort,
} from './transports/websocket';

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
  readonly createHost: () => RuntimeHost;
  /** Diagnostics; the protocol itself never writes here. */
  readonly log?: (message: string) => void;
  /** Stops the server. A signal handler aborts it. */
  readonly signal?: AbortSignal;
}

export interface RuntimeServeHandle {
  readonly hostname: string;
  readonly port: number;
  /** Resolves once the server has stopped accepting connections. */
  readonly stopped: Promise<void>;
  close(): void;
}

interface ActiveSession {
  readonly generation: number;
  readonly socket: ServerWebSocketLike & {
    close(code?: number, reason?: string): void;
  };
  readonly port: WebSocketFramePort;
  readonly host: RuntimeHost;
  stopLiveness?: () => void;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface ServeSocketData {
  generation: number;
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
  let active: ActiveSession | null = null;
  let generation = 0;
  let closed = false;

  const stopped = Promise.withResolvers<void>();

  const teardownSession = (session: ActiveSession, notifySocket: boolean): void => {
    session.stopLiveness?.();
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.host.close();
    session.port.close();
    if (notifySocket) {
      try {
        session.socket.close(RUNTIME_CLOSE_CODES.SUPERSEDED, 'Superseded');
      } catch {
        // Already closed.
      }
    }
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

      if (self.upgrade(request, { data: { generation: 0 } })) return undefined;
      return new Response(null, { status: 500 });
    },
    websocket: {
      maxPayloadLength: RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
      // Match the frame port's queue budget so a slow hub drains through
      // backpressure instead of Bun closing the socket at 64 KiB.
      backpressureLimit: RUNTIME_MAX_FRAME_BYTES,
      closeOnBackpressureLimit: true,
      idleTimeout: 0,
      open(socket) {
        if (active) {
          const previous = active;
          active = null;
          teardownSession(previous, true);
          log('A new hub connection superseded the previous one.');
        }

        const mine = ++generation;
        const host = options.createHost();
        const port = createWebSocketFramePort({
          sink: serverWebSocketSink(socket),
          onClosed: (closure) => {
            if (closure.kind === 'protocol-error') {
              log(`Protocol framing rejected a message: ${closure.error.message}`);
              socket.close(RUNTIME_CLOSE_CODES.PROTOCOL_ERROR, 'Protocol error');
            }
          },
        });

        socket.data.generation = mine;
        const session: ActiveSession = {
          generation: mine,
          socket,
          port,
          host,
        };
        active = session;

        host.attach(port);
        host.start();

        void (async () => {
          const handshake = await Promise.race([
            host.waitUntilReady().then(
              () => null,
              (error: unknown) => asError(error)
            ),
            sleepMs(HANDSHAKE_TIMEOUT_MS).then(
              () => new Error('The hub did not acknowledge the protocol handshake in time.')
            ),
          ]);
          if (active?.generation !== mine) return;
          if (handshake) {
            log(`Handshake failed: ${handshake.message}`);
            socket.close(1000, 'Handshake failed');
            return;
          }

          session.stopLiveness = startProtocolLiveness({
            ping: () => host.ping(),
            onPong: (listener) => host.onPong(listener),
            intervalMs: LIVENESS_INTERVAL_MS,
            onTimeout: () => {
              log('Hub stopped answering protocol pings.');
              socket.close(RUNTIME_CLOSE_CODES.RELEASED, 'Liveness timeout');
            },
          });
          // No immediate beat: an early heartbeat would consume seq 0 on the
          // topic before a freshly connected hub had a chance to observe it,
          // and the interval is already short enough for card freshness.
          session.heartbeat = setInterval(() => {
            host.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: Date.now() } });
          }, HEARTBEAT_INTERVAL_MS);
          (session.heartbeat as { unref?: () => void }).unref?.();
          log('Hub connected.');
        })();
      },
      message(socket, message) {
        if (active?.generation !== socket.data.generation) return;
        active.port.receive(message);
      },
      drain(socket) {
        if (active?.generation !== socket.data.generation) return;
        active.port.handleDrain();
      },
      close(socket) {
        if (active?.generation !== socket.data.generation) return;
        const session = active;
        active = null;
        session.port.handleSocketClosed();
        teardownSession(session, false);
      },
    },
  });

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (active) {
      const session = active;
      active = null;
      teardownSession(session, true);
    }
    server.stop(true);
    stopped.resolve();
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
