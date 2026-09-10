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

import { CLOSE_CODES, RemoteError } from '@mangostudio/protocol';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
} from '@mangostudio/protocol/ws';
import {
  narrowRuntimeErrorCode,
  RUNTIME_HEARTBEAT_TOPIC,
} from '@mangostudio/shared/runtime-contract';
import { Elysia } from 'elysia';
import { getConfig, getVersion } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { extractClientIp } from '../../../plugins/rate-limit';
import { RATE_LIMIT_BUCKETS } from '../../../plugins/rate-limit-policy';
import { RateLimitStore } from '../../../plugins/rate-limit-store';
import {
  openHubSession,
  type ProtocolHubSession,
} from '../../../services/runtime-client/hub-session';
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
  rejection: 'unauthorized' | 'internal' | 'rate-limited' | null;
  /** The port's handle: what the socket's own callbacks feed. */
  feed: WebSocketPortHandle | null;
  /** The handshaked runtime, once there is one. */
  hub: ProtocolHubSession | null;
  /** Set once the manager owns this connection, so close can release it. */
  adopted: boolean;
  /** Set by the close handler, which can run while adoption is still in flight. */
  socketClosed: boolean;
  /**
   * Set the first time anything closes the transport. Three parties can: the
   * port on a frame it refused, the session on release, and this route on a
   * refusal of its own. The first code is the one that says why, and a second
   * close would replace "your binary is too old" with something vaguer.
   */
  transportClosed: boolean;
}

/**
 * Peer address for the upgrade, resolved the same way the HTTP limiter does.
 * Mirrored rather than shared because the limiter reads it off an Elysia
 * context this route never builds.
 */
interface RuntimeUpgradeServer {
  requestIP(request: Request): { address: string } | null;
}

/** Minimal shape of the socket, mirroring how realtime-routes narrows its own. */
interface RuntimeSocket {
  close(code?: number, reason?: string): unknown;
  raw: {
    send(message: Uint8Array, compress?: boolean): number;
    close(code?: number, reason?: string): void;
  };
  /**
   * Elysia flattens derived values onto the socket context rather than
   * nesting them under `data`, which now carries the route's own wiring.
   */
  runtimeSocket: RuntimeSocketState;
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

/** RFC 6455: an acceptor may only name a subprotocol the dialler offered. */
function offersMangoSubprotocol(header: string | null): boolean {
  return (header ?? '').split(',').some((protocol) => protocol.trim() === WEBSOCKET_SUBPROTOCOL);
}

export interface RuntimeSocketRouteDependencies {
  readonly pairing?: RuntimePairingService;
  readonly manager?: RuntimeConnectionManager;
  readonly hubVersion?: () => string;
  /** Upgrades one address may open per window; the shared bucket by default. */
  readonly upgradeLimit?: { readonly max: number; readonly windowMs: number };
}

export function createRuntimeSocketRoutes(dependencies: RuntimeSocketRouteDependencies = {}) {
  const pairing = dependencies.pairing ?? runtimePairingService;
  const resolveManager = (): RuntimeConnectionManager =>
    dependencies.manager ?? getRuntimeConnectionManager();
  const hubVersion = dependencies.hubVersion ?? getVersion;
  const upgradeLimit = dependencies.upgradeLimit ?? RATE_LIMIT_BUCKETS.runtimeSocket;
  // Counted here rather than in the global HTTP hook so the refusal can be a
  // close code. One store per route instance, sized like the shared one: the
  // keys are client addresses, and the same flood bound applies.
  const upgrades = new RateLimitStore(10_000);

  /** False once this address has opened more upgrades than its window allows. */
  function admitUpgrade(request: Request, server: RuntimeUpgradeServer | null): boolean {
    const clientIp = extractClientIp(
      request.headers,
      server?.requestIP(request)?.address,
      getConfig().security.trustProxy
    );
    // Same rule the limiter applies: a caller it cannot identify is a caller it
    // cannot fairly limit.
    if (clientIp === 'unknown') return true;
    const now = Date.now();
    upgrades.removeExpired(now);
    const entry = upgrades.touch(`runtime-upgrade:${clientIp}`, upgradeLimit.windowMs, now);
    upgrades.evictOverflow();
    return entry.count <= upgradeLimit.max;
  }

  /** Closes the socket, unless something already closed it with a better code. */
  function closeTransport(
    socket: RuntimeSocket,
    state: RuntimeSocketState,
    code: number,
    reason: string
  ): void {
    if (state.transportClosed) return;
    state.transportClosed = true;
    socket.raw.close(code, reason);
  }

  return new Elysia({ name: 'runtime-socket-routes' })
    .derive(async ({ request, server }) => {
      // Verified before the upgrade so an unknown credential never reaches the
      // manager, and rejected in `open` so the peer gets a typed close code
      // rather than a bare HTTP status it has no framing to read.
      const token = bearerToken(request.headers.get('authorization'));
      let peer: VerifiedPeer | null = null;
      let rejection: RuntimeSocketState['rejection'] = null;

      if (!admitUpgrade(request, (server as RuntimeUpgradeServer | null) ?? null)) {
        rejection = 'rate-limited';
      } else if (!token) {
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
          feed: null,
          hub: null,
          adopted: false,
          socketClosed: false,
          transportClosed: false,
        } satisfies RuntimeSocketState,
      };
    })
    .ws(RUNTIME_SOCKET_PATH, {
      // Returns the response headers of the upgrade, and names the subprotocol
      // only when the dialer offered it: a runtime on the previous wire offers
      // nothing, and naming one it did not ask for makes it drop the upgrade —
      // before it could be told, with close 4426, that its binary is the thing
      // to fix.
      upgrade({ request }) {
        const offered = request.headers.get('sec-websocket-protocol');
        if (!offersMangoSubprotocol(offered)) return undefined;
        return { 'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL };
      },
      open(rawSocket) {
        const socket = rawSocket as unknown as RuntimeSocket;
        const state = socket.runtimeSocket;

        if (state.rejection === 'internal') {
          socket.close(CLOSE_CODES.INTERNAL, 'Internal error');
          return;
        }
        if (state.rejection === 'rate-limited') {
          socket.close(CLOSE_CODES.RATE_LIMITED, 'Too many upgrades');
          return;
        }
        if (state.rejection || !state.peer) {
          socket.close(CLOSE_CODES.UNAUTHORIZED, 'Unauthorized');
          return;
        }

        state.feed = createWebSocketPort({
          send: (bytes) => outcomeOfBunSend(socket.raw.send(bytes)),
          close: (code, reason) => closeTransport(socket, state, code, reason ?? ''),
        });
        void adopt(socket, state, state.peer);
      },
      message(rawSocket, message) {
        const socket = rawSocket as unknown as RuntimeSocket;
        // Text reaches the port too: it is the one that has to call a text
        // frame a protocol error, and close with the code that says so.
        socket.runtimeSocket.feed?.onMessage(message as Uint8Array | ArrayBuffer | string);
      },
      drain(rawSocket) {
        const socket = rawSocket as unknown as RuntimeSocket;
        socket.runtimeSocket.feed?.onDrain();
      },
      close(rawSocket, code, reason) {
        const socket = rawSocket as unknown as RuntimeSocket;
        const state = socket.runtimeSocket;
        state.socketClosed = true;
        state.transportClosed = true;
        state.feed?.onClose(code ?? CLOSE_CODES.RELEASED, reason);
        state.feed = null;
        // Releasing here rather than on the session's own close covers the
        // codes no frame ever announced — a supersede, a revoked token, a peer
        // that simply vanished — so the card stops claiming a connection that
        // ended.
        if (state.adopted && state.peer) {
          state.adopted = false;
          resolveManager().disconnect(state.peer.userId, state.peer.environmentId);
        }
      },
    });

  async function adopt(
    socket: RuntimeSocket,
    state: RuntimeSocketState,
    peer: VerifiedPeer
  ): Promise<void> {
    // Before adoption, not after, and awaited: adoption is what publishes the
    // environments topic, and a UI that refetches on that signal must not read
    // `lastSeenAt` back one write too early. A failure here is a stale
    // timestamp, never a reason to refuse a connection, so it is swallowed.
    await pairing.markSeen(peer.tokenId).catch((error: unknown) => {
      logger.warn('mark_seen_failed', {
        environmentId: peer.environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    try {
      await resolveManager().adopt(peer.userId, peer.environmentId, (onUnavailable) =>
        openConnection(state, peer, onUnavailable)
      );
      state.adopted = true;
    } catch (error) {
      logger.warn('adoption_refused', {
        environmentId: peer.environmentId,
        ...(error instanceof RemoteError ? { code: narrowRuntimeErrorCode(error.code) } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      // A handshake the wire itself refused has already closed the socket with
      // the code that names the fault — 4426 for a runtime whose `hello` this
      // version cannot read. `closeTransport` keeps that first code, so this
      // line speaks only for the refusals the manager raises before a session
      // exists: "enable this environment" and "update this binary" are
      // different jobs for different people.
      closeTransport(socket, state, CLOSE_CODES.FORBIDDEN, 'Environment unavailable');
      return;
    }

    // The peer can vanish while the handshake is in flight. `close` ran with
    // `adopted` still false, so it left the manager holding an entry for a
    // socket that is gone — and the card claiming a connection nobody has.
    if (state.socketClosed) {
      state.adopted = false;
      resolveManager().disconnect(peer.userId, peer.environmentId);
      return;
    }

    // The credential was checked before the upgrade, and a handshake takes
    // long enough for a rotation or a revocation to land in between. Revoking
    // drops whatever the manager holds — but if it ran while this adoption was
    // still in flight there was nothing to drop, and the socket would serve on
    // a credential that no longer exists. Re-reading after the entry is
    // installed closes that order: either revocation sees this connection, or
    // this connection sees the revocation.
    if (!(await pairing.isActive(peer.tokenId))) {
      logger.warn('credential_retired_during_adoption', { environmentId: peer.environmentId });
      state.adopted = false;
      // Closed before the manager is told, and that order is the point: the
      // manager's own release closes with `RELEASED`, which reads as "the hub
      // let you go, come back". A retired credential must say `UNAUTHORIZED`
      // or the runtime redials forever against a token that no longer exists.
      state.hub?.close(CLOSE_CODES.UNAUTHORIZED, 'Unauthorized');
      resolveManager().disconnect(peer.userId, peer.environmentId);
    }
  }

  async function openConnection(
    state: RuntimeSocketState,
    peer: VerifiedPeer,
    onUnavailable: () => void
  ): Promise<ManagedRuntimeConnection> {
    const feed = state.feed;
    if (!feed) {
      throw new Error(
        `Runtime socket for environment "${peer.environmentId}" has no port; expected one built in the open handler.`
      );
    }
    // `requireMatchingRelease` is deliberately off: a remote runtime is not
    // part of the hub's own distribution, so release equality cannot be a
    // connection gate. The wire major still is, and release drift becomes
    // visible card state instead of a refused socket.
    const hub = await openHubSession(feed.port, {
      hubVersion: hubVersion(),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      requireMatchingRelease: false,
    });
    state.hub = hub;

    // No liveness of this route's own: the session pings on its own cadence,
    // which is well inside the socket's idle timeout in both directions.
    hub.onEvent((event) => {
      if (event.topic !== RUNTIME_HEARTBEAT_TOPIC) return;
      void pairing.markSeen(peer.tokenId).catch(() => undefined);
    });
    return {
      client: new RuntimeClient(hub, onUnavailable, peer.environmentId),
      close(reason) {
        // The manager is releasing this connection, so the socket's own close
        // handler must not turn around and release it again — by then the
        // entry may already belong to the runtime that superseded this one.
        state.adopted = false;
        hub.close(
          reason === 'superseded' ? CLOSE_CODES.SUPERSEDED : CLOSE_CODES.RELEASED,
          reason === 'superseded' ? 'Superseded' : 'Released'
        );
      },
    };
  }
}

export const runtimeSocketRoutes = createRuntimeSocketRoutes();
