/**
 * `/api/runtime` — the endpoint a paired runtime dials.
 *
 * This is a peer endpoint, not a bus topic. The browser bus on `/api/ws` carries
 * invalidation events to many short-lived sockets owned by a logged-in session;
 * this carries the runtime protocol over one long-lived socket owned by a
 * machine credential. They share an Elysia instance — and therefore Bun's
 * single set of socket options — and nothing else. Reaching for the bus's
 * helpers here would couple two peer models that have no reason to move
 * together.
 */

import {
  createWebSocketFramePort,
  livenessIntervalFor,
  RuntimeProtocolClient,
  serverWebSocketSink,
  startProtocolLiveness,
  type WebSocketFramePort,
} from '@mangostudio/runtime';
import { REALTIME_IDLE_TIMEOUT_SECONDS } from '@mangostudio/shared/realtime';
import { RUNTIME_CLOSE_CODES, RUNTIME_HEARTBEAT_TOPIC } from '@mangostudio/shared/runtime-protocol';
import { Elysia } from 'elysia';
import { getVersion } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { RuntimeClient } from '../../../services/runtime-client/runtime-client';
import {
  getRuntimeConnectionManager,
  type ManagedRuntimeConnection,
  type RuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import {
  type RuntimePairingService,
  runtimePairingService,
} from '../application/runtime-pairing-service';

/** Mounted under the `/api` prefix; `isRuntimeSocketPath` matches both forms. */
const RUNTIME_SOCKET_PATH = '/runtime';

const HANDSHAKE_TIMEOUT_MS = 15_000;

const logger = createDiagnosticLogger('runtime-ws');

interface VerifiedPeer {
  readonly tokenId: string;
  readonly userId: string;
  readonly environmentId: string;
}

interface RuntimeSocketState {
  peer: VerifiedPeer | null;
  /** Why the upgrade will be refused in `open`, if it will be. */
  rejection: 'unauthorized' | 'internal' | null;
  port: WebSocketFramePort | null;
  stopLiveness: (() => void) | null;
  detachEvents: (() => void) | null;
  /** Set once the manager owns this connection, so close can release it. */
  adopted: boolean;
}

/** Minimal shape of the socket, mirroring how realtime-routes narrows its own. */
interface RuntimeSocket {
  close(code?: number, reason?: string): unknown;
  raw: { send(message: Uint8Array, compress?: boolean): number };
  data: { runtimeSocket: RuntimeSocketState };
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

export interface RuntimeSocketRouteDependencies {
  readonly pairing?: RuntimePairingService;
  readonly manager?: RuntimeConnectionManager;
  readonly hubVersion?: () => string;
  readonly idleTimeoutSeconds?: number;
}

export function createRuntimeSocketRoutes(dependencies: RuntimeSocketRouteDependencies = {}) {
  const pairing = dependencies.pairing ?? runtimePairingService;
  const resolveManager = (): RuntimeConnectionManager =>
    dependencies.manager ?? getRuntimeConnectionManager();
  const hubVersion = dependencies.hubVersion ?? getVersion;
  const livenessMs = livenessIntervalFor(
    dependencies.idleTimeoutSeconds ?? REALTIME_IDLE_TIMEOUT_SECONDS
  );

  function teardown(state: RuntimeSocketState): void {
    state.stopLiveness?.();
    state.stopLiveness = null;
    state.detachEvents?.();
    state.detachEvents = null;
  }

  return new Elysia({ name: 'runtime-socket-routes' })
    .derive(async ({ request }) => {
      // Verified before the upgrade so an unknown credential never reaches the
      // manager, and rejected in `open` so the peer gets a typed close code
      // rather than a bare HTTP status it has no framing to read.
      const token = bearerToken(request.headers.get('authorization'));
      let peer: VerifiedPeer | null = null;
      let rejection: RuntimeSocketState['rejection'] = null;

      if (!token) {
        rejection = 'unauthorized';
      } else {
        try {
          peer = await pairing.verify(token);
          if (!peer) rejection = 'unauthorized';
        } catch (error) {
          // Never log the token, not even truncated: a diagnostic log is one of
          // the places a credential most easily outlives its rotation.
          logger.error('pairing_verification_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          rejection = 'internal';
        }
      }

      return {
        runtimeSocket: {
          peer,
          rejection,
          port: null,
          stopLiveness: null,
          detachEvents: null,
          adopted: false,
        } satisfies RuntimeSocketState,
      };
    })
    .ws(RUNTIME_SOCKET_PATH, {
      open(rawSocket) {
        const socket = rawSocket as unknown as RuntimeSocket;
        const state = socket.data.runtimeSocket;

        if (state.rejection === 'internal') {
          socket.close(RUNTIME_CLOSE_CODES.INTERNAL, 'Internal error');
          return;
        }
        if (state.rejection || !state.peer) {
          socket.close(RUNTIME_CLOSE_CODES.UNAUTHORIZED, 'Unauthorized');
          return;
        }

        const peer = state.peer;
        const port = createWebSocketFramePort({
          sink: serverWebSocketSink(socket.raw),
          onClosed: (closure) => {
            if (closure.kind === 'protocol-error') {
              logger.error('frame_rejected', {
                environmentId: peer.environmentId,
                error: closure.error.message,
              });
              socket.close(RUNTIME_CLOSE_CODES.PROTOCOL_ERROR, 'Protocol error');
            }
            teardown(state);
          },
        });
        state.port = port;

        void adopt(socket, state, peer, port);
      },
      message(rawSocket, message) {
        const socket = rawSocket as unknown as RuntimeSocket;
        socket.data.runtimeSocket.port?.receive(message as ArrayBufferView | string);
      },
      drain(rawSocket) {
        const socket = rawSocket as unknown as RuntimeSocket;
        socket.data.runtimeSocket.port?.handleDrain();
      },
      close(rawSocket) {
        const socket = rawSocket as unknown as RuntimeSocket;
        const state = socket.data.runtimeSocket;
        teardown(state);
        state.port?.handleSocketClosed();
        state.port = null;
        // Releasing here rather than in the port's `onClosed` covers the codes
        // the port never sees — a supersede, a revoked token, a peer that
        // simply vanished — so the card stops claiming a connection that ended.
        if (state.adopted && state.peer) {
          state.adopted = false;
          resolveManager().disconnect(state.peer.userId, state.peer.environmentId);
        }
      },
    });

  async function adopt(
    socket: RuntimeSocket,
    state: RuntimeSocketState,
    peer: VerifiedPeer,
    port: WebSocketFramePort
  ): Promise<void> {
    try {
      await resolveManager().adopt(peer.userId, peer.environmentId, (onUnavailable) =>
        openConnection(socket, state, peer, port, onUnavailable)
      );
      state.adopted = true;
      await pairing.markSeen(peer.tokenId);
    } catch (error) {
      logger.warn('adoption_refused', {
        environmentId: peer.environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      teardown(state);
      socket.close(RUNTIME_CLOSE_CODES.FORBIDDEN, 'Environment unavailable');
    }
  }

  async function openConnection(
    socket: RuntimeSocket,
    state: RuntimeSocketState,
    peer: VerifiedPeer,
    port: WebSocketFramePort,
    onUnavailable: () => void
  ): Promise<ManagedRuntimeConnection> {
    // `requireMatchingRelease` is deliberately unset: a remote runtime is not
    // part of the hub's own distribution, so release equality cannot be a
    // connection gate. The protocol major/minor still is, and release drift
    // becomes visible card state instead of a refused socket.
    const client = new RuntimeProtocolClient(port, {
      hubVersion: hubVersion(),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    await client.waitUntilReady();

    state.detachEvents = client.onEvent((event) => {
      if (event.topic !== RUNTIME_HEARTBEAT_TOPIC) return;
      void pairing.markSeen(peer.tokenId).catch(() => undefined);
    });
    state.stopLiveness = startProtocolLiveness({
      ping: () => client.ping(),
      onPong: (listener) => client.onPong(listener),
      intervalMs: livenessMs,
      onTimeout: () => {
        logger.warn('liveness_timeout', { environmentId: peer.environmentId });
        socket.close(RUNTIME_CLOSE_CODES.RELEASED, 'Liveness timeout');
      },
    });
    return {
      client: new RuntimeClient(client, onUnavailable),
      close(reason) {
        // The manager is releasing this connection, so the socket's own close
        // handler must not turn around and release it again — by then the
        // entry may already belong to the runtime that superseded this one.
        state.adopted = false;
        teardown(state);
        client.close();
        socket.close(
          reason === 'superseded' ? RUNTIME_CLOSE_CODES.SUPERSEDED : RUNTIME_CLOSE_CODES.RELEASED,
          reason === 'superseded' ? 'Superseded' : 'Released'
        );
      },
    };
  }
}

export const runtimeSocketRoutes = createRuntimeSocketRoutes();
