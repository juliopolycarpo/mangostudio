/**
 * `/api/terminal/:id` — the browser-facing socket for one live terminal
 * session.
 *
 * Authentication and Origin checking are the same as `/api/ws` (see
 * `browser-socket-handshake.ts`); ownership, single-viewer takeover, and the
 * runtime relay are this route's own. Flow control on the way out lives in
 * `terminal-socket-relay.ts`, a pure module this route only wires up to a
 * real socket.
 */

import type { RuntimeTerminalOutputEvent } from '@mangostudio/runtime';
import {
  chunkTerminalBytes,
  decodeTerminalClientMessage,
  encodeTerminalServerMessage,
  TERMINAL_CHUNK_MAX_BYTES,
  TERMINAL_SOCKET_CLOSE_CODES,
} from '@mangostudio/shared/terminal';
import { Elysia, t } from 'elysia';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  type BrowserSocketRejection,
  createBrowserSocketHandshake,
} from '../../../plugins/browser-socket-handshake';
import {
  type TerminalSessionService,
  type TerminalSessionViewer,
  terminalSessionService,
} from '../application/terminal-session-service';
import {
  createTerminalSocketRelay,
  type TerminalSocketRelay,
} from '../application/terminal-socket-relay';
import type { TerminalRuntimeClient } from '../domain/terminal-runtime-client';

const logger = createDiagnosticLogger('terminals-ws');

/** Standard "malformed frame" WS close code. */
const PROTOCOL_ERROR_CLOSE_CODE = 1003;

interface TerminalSocketState {
  userId: string | null;
  rejection: BrowserSocketRejection;
  sessionId: string;
  client: TerminalRuntimeClient | null;
  relay: TerminalSocketRelay | null;
  viewer: TerminalSessionViewer | null;
  unsubscribeOutput: (() => void) | null;
  socketClosed: boolean;
  /** Serializes async message handlers so client writes cannot reorder. */
  messageChain: Promise<void>;
}

interface TerminalSocket {
  params: { id: string };
  close(code?: number, reason?: string): unknown;
  raw: {
    send(message: Uint8Array, compress?: boolean): number;
    getBufferedAmount(): number;
    close(code?: number, reason?: string): void;
  };
  /**
   * Elysia flattens derived values onto the socket context rather than
   * nesting them under `data`, which now carries the route's own wiring.
   */
  terminalSocket: TerminalSocketState;
}

export interface TerminalSocketRouteDependencies {
  readonly service?: TerminalSessionService;
  readonly resolveUserId?: (headers: Headers) => Promise<string | null>;
  readonly allowedOrigins?: readonly string[];
}

function toClientBytes(message: string | Buffer): Uint8Array | null {
  // The client never sends a text frame; one arriving is a protocol error.
  if (typeof message === 'string') return null;
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

export function createTerminalSocketRoutes(dependencies: TerminalSocketRouteDependencies = {}) {
  const service = dependencies.service ?? terminalSessionService;
  const resolveHandshake = createBrowserSocketHandshake({
    resolveUserId: dependencies.resolveUserId,
    allowedOrigins: dependencies.allowedOrigins,
    onSessionResolutionError: (error) => {
      logger.error('session_resolution_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  /**
   * Quiesces the runtime stream, attaches, replays scrollback, and wires the
   * live relay for one socket — in that order, because it is the order that
   * makes every frame either scrollback or newer than it.
   */
  async function attach(socket: TerminalSocket, state: TerminalSocketState): Promise<void> {
    const userId = state.userId as string;
    const found = service.getForAttach(userId, state.sessionId);
    if (!found) {
      socket.close(TERMINAL_SOCKET_CLOSE_CODES.NOT_FOUND, 'Not found');
      return;
    }
    const { client } = found;
    state.client = client;

    const relay = createTerminalSocketRelay({
      send: (frame) => socket.raw.send(frame, false),
      getBufferedAmount: () => socket.raw.getBufferedAmount(),
      close: (code, reason) => socket.raw.close(code, reason),
      buildOverflowNotice: (bytes) =>
        encodeTerminalServerMessage({ type: 'notice', notice: { kind: 'queue_overflow', bytes } }),
    });
    state.relay = relay;

    const viewer: TerminalSessionViewer = {
      pushNotice: (notice) => relay.push(encodeTerminalServerMessage({ type: 'notice', notice })),
      close: (code, reason) => socket.raw.close(code, reason),
    };
    state.viewer = viewer;
    // A second upgrade for the same session takes over: the previous viewer is
    // closed, on purpose, with the code that says a client must not reconnect.
    const { replaced } = service.attachViewer(state.sessionId, viewer);
    replaced?.close(TERMINAL_SOCKET_CLOSE_CODES.REPLACED, 'Replaced by a new viewer');

    // Quiesce the stream before attaching. A predecessor may still be attached
    // on the runtime — a takeover, or a closed socket whose `terminal.detach`
    // is still in flight — and its frames are already in the scrollback this
    // attach is about to snapshot. Frames the port delivers in the same read as
    // this response are dispatched before the continuation below resumes, so
    // there is no way to tell them apart after the fact; having the runtime
    // stop emitting first is what makes everything that arrives from here on
    // unambiguously newer than the snapshot.
    try {
      await client.terminal.detach({ sessionId: state.sessionId });
    } catch {
      // The session is gone on the runtime, or the connection is: the attach
      // below fails with the same cause and closes the socket for it.
    }

    // A takeover during that round trip must stop this socket here: attaching
    // after the successor did would re-snapshot its scrollback and hand it a
    // duplicate of everything in between. Viewer identity is what answers that,
    // rather than `socketClosed` alone — the handoff is recorded synchronously,
    // so this holds however the runtime schedules the replaced socket's `close`.
    if (state.socketClosed || !service.isCurrentViewer(state.sessionId, viewer)) {
      service.detachViewer(state.sessionId, viewer);
      return;
    }

    // Subscribed before the request, because the runtime starts emitting the
    // moment its `attach()` runs and the topic has no buffer of its own.
    // Frames wait in `queued` until the scrollback has been replayed, so live
    // output cannot overtake the replay it continues. Nothing is acknowledged
    // while they wait, so the runtime's in-flight window bounds the queue.
    let queued: RuntimeTerminalOutputEvent[] | null = [];
    const handleOutput = (event: RuntimeTerminalOutputEvent): void => {
      if (state.socketClosed) return;
      switch (event.kind) {
        case 'data':
          relay.push(
            encodeTerminalServerMessage({ type: 'data', data: Buffer.from(event.data, 'base64') })
          );
          return;
        case 'dropped':
          relay.push(
            encodeTerminalServerMessage({
              type: 'notice',
              notice: { kind: 'dropped', bytes: event.bytes },
            })
          );
          return;
        case 'exit': {
          const exit = { exitCode: event.exitCode, signal: event.signal };
          service.recordExit(state.sessionId, exit);
          relay.push(encodeTerminalServerMessage({ type: 'exit', exit }));
          socket.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Session exited');
        }
      }
    };
    state.unsubscribeOutput = client.terminal.onOutput(state.sessionId, (event) => {
      if (queued) {
        queued.push(event);
        return;
      }
      handleOutput(event);
    });

    let attachResult: Awaited<ReturnType<TerminalRuntimeClient['terminal']['attach']>>;
    try {
      attachResult = await client.terminal.attach({ sessionId: state.sessionId });
    } catch (error) {
      logger.warn('attach_failed', {
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      teardown(state);
      service.detachViewer(state.sessionId, viewer);
      socket.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Session unavailable');
      return;
    }

    if (state.socketClosed) {
      // The browser hung up, or a takeover replaced this viewer, while
      // attach() was in flight. Only detach the runtime if this was still
      // the current viewer: a takeover already moved that job onto the
      // successor, and detaching here would stop its stream instead.
      teardown(state);
      const wasCurrent = service.detachViewer(state.sessionId, viewer);
      if (wasCurrent) {
        void client.terminal.detach({ sessionId: state.sessionId }).catch(() => undefined);
      }
      return;
    }

    const scrollback = Buffer.from(attachResult.scrollback, 'base64');
    for (const chunk of chunkTerminalBytes(scrollback, TERMINAL_CHUNK_MAX_BYTES)) {
      relay.push(encodeTerminalServerMessage({ type: 'data', data: chunk }));
    }

    if (attachResult.status === 'exited') {
      // Nothing can have been queued: the runtime emits only while attached,
      // and this session had already ended before it was.
      teardown(state);
      const exit = { exitCode: attachResult.exitCode, signal: attachResult.signal };
      service.recordExit(state.sessionId, exit);
      relay.push(encodeTerminalServerMessage({ type: 'exit', exit }));
      socket.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Session exited');
      return;
    }

    const replayed = queued;
    queued = null;
    for (const event of replayed) handleOutput(event);
  }

  function teardown(state: TerminalSocketState): void {
    state.unsubscribeOutput?.();
    state.unsubscribeOutput = null;
  }

  async function handleClientMessage(socket: TerminalSocket, bytes: Uint8Array): Promise<void> {
    const state = socket.terminalSocket;
    const client = state.client;
    // A message already queued in `messageChain` when a takeover closes this
    // socket must not reach the runtime after the fact: `state.client` is
    // never cleared, so only `socketClosed` catches a dequeued handler that
    // starts running after the close.
    if (!client || state.socketClosed) return;

    let decoded: ReturnType<typeof decodeTerminalClientMessage>;
    try {
      decoded = decodeTerminalClientMessage(bytes);
    } catch (error) {
      logger.warn('malformed_client_frame', {
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.close(PROTOCOL_ERROR_CLOSE_CODE, 'Malformed frame');
      return;
    }

    try {
      switch (decoded.type) {
        case 'data':
          await client.terminal.write({
            sessionId: state.sessionId,
            data: Buffer.from(decoded.data).toString('base64'),
          });
          service.touchActivity(state.sessionId);
          return;
        case 'resize':
          await client.terminal.resize({
            sessionId: state.sessionId,
            cols: decoded.cols,
            rows: decoded.rows,
          });
          service.recordResize(state.sessionId, decoded.cols, decoded.rows);
          return;
        case 'ack':
          await client.terminal.ack({ sessionId: state.sessionId, bytes: decoded.bytes });
          return;
        case 'ping':
          state.relay?.push(encodeTerminalServerMessage({ type: 'pong' }));
          return;
      }
    } catch (error) {
      logger.warn('client_frame_failed', {
        sessionId: state.sessionId,
        type: decoded.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return new Elysia({ name: 'terminal-socket-routes' })
    .derive(async ({ request }) => {
      const { userId, rejection } = await resolveHandshake(request.headers);
      return {
        terminalSocket: {
          userId,
          rejection,
          sessionId: '',
          client: null,
          relay: null,
          viewer: null,
          unsubscribeOutput: null,
          socketClosed: false,
          messageChain: Promise.resolve(),
        } satisfies TerminalSocketState,
      };
    })
    .ws('/terminal/:id', {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      open(rawSocket) {
        const socket = rawSocket as unknown as TerminalSocket;
        const state = socket.terminalSocket;
        state.sessionId = socket.params.id;

        if (state.rejection === 'forbidden') {
          socket.close(TERMINAL_SOCKET_CLOSE_CODES.FORBIDDEN, 'Forbidden');
          return;
        }
        if (state.rejection === 'internal') {
          socket.close(TERMINAL_SOCKET_CLOSE_CODES.INTERNAL_ERROR, 'Internal error');
          return;
        }
        if (state.rejection === 'unauthorized' || !state.userId) {
          socket.close(TERMINAL_SOCKET_CLOSE_CODES.UNAUTHORIZED, 'Unauthorized');
          return;
        }

        void attach(socket, state);
      },
      message(rawSocket, rawMessage) {
        const socket = rawSocket as unknown as TerminalSocket;
        const state = socket.terminalSocket;
        if (state.socketClosed) return;

        const bytes = toClientBytes(rawMessage as string | Buffer);
        if (!bytes) {
          socket.close(PROTOCOL_ERROR_CLOSE_CODE, 'Malformed frame');
          return;
        }

        // Serialized per socket: a write and the resize behind it must reach
        // the runtime in the order the browser sent them.
        const run = (): Promise<void> => handleClientMessage(socket, bytes);
        const queued = state.messageChain.then(run, run);
        state.messageChain = queued.then(
          () => undefined,
          () => undefined
        );
      },
      drain(rawSocket) {
        const socket = rawSocket as unknown as TerminalSocket;
        socket.terminalSocket.relay?.drain();
      },
      close(rawSocket) {
        const socket = rawSocket as unknown as TerminalSocket;
        const state = socket.terminalSocket;
        state.socketClosed = true;
        teardown(state);
        // Only the viewer that still holds the session detaches it on the
        // runtime. A socket closed with REPLACED reaches here after its
        // successor attached; sending `terminal.detach` then would silence
        // the new viewer's stream.
        const wasCurrent = state.viewer
          ? service.detachViewer(state.sessionId, state.viewer)
          : false;
        const client = state.client;
        if (wasCurrent && client && state.sessionId) {
          void client.terminal.detach({ sessionId: state.sessionId }).catch(() => undefined);
        }
      },
    });
}

export const terminalSocketRoutes = createTerminalSocketRoutes();
