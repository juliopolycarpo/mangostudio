/**
 * Hub dial-out to a Direct URL runtime (`transportKind: 'http'`).
 *
 * The runtime listens with `mangostudio-runtime serve`; the hub opens a
 * WebSocket with the stored bearer token and speaks wire 1.0 under the
 * `mango.v1` subprotocol, the same as the paired dial-in path. Release equality
 * is not a gate — the binary on that machine is not part of this hub's
 * distribution.
 */

import { CLOSE_CODES, type Port, RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { connectWebSocket } from '@mangostudio/protocol/ws';
import { dialDeadline } from '@mangostudio/shared/utils/dial-deadline';
import { getVersion } from '../../lib/config';
import { createDiagnosticLogger } from '../../lib/logger';
import { environmentConfigFor } from '../../modules/environments/domain/environment-config';
import { httpRuntimeBaseUrlToWebSocketUrl } from './http-runtime-url';
import { openHubSession, type ProtocolHubSession } from './hub-session';
import { RuntimeClient } from './runtime-client';
import { readRuntimeToken } from './runtime-token-secrets';

const HANDSHAKE_TIMEOUT_MS = 15_000;

const logger = createDiagnosticLogger('runtime-http');

/** Minimal definition shape — kept local to avoid a cycle with the manager. */
export interface HttpRuntimeDefinition {
  readonly id: string;
  readonly userId: string;
  readonly config: unknown;
}

export interface HttpRuntimeConnection {
  readonly client: RuntimeClient;
  close(reason?: 'released' | 'superseded'): void | Promise<void>;
}

export async function connectHttpRuntime(
  definition: HttpRuntimeDefinition,
  onUnavailable: () => void
): Promise<HttpRuntimeConnection> {
  const { baseUrl } = environmentConfigFor('http', definition.config);
  const wsUrl = httpRuntimeBaseUrlToWebSocketUrl(baseUrl);
  const token = await readRuntimeToken(definition.userId, definition.id);

  let hub: ProtocolHubSession;
  try {
    hub = await openRuntimeSession(wsUrl, token);
  } catch (error) {
    throw asConnectError(error, definition.id, baseUrl);
  }

  let notified = false;
  const notifyGone = (): void => {
    if (notified) return;
    notified = true;
    onUnavailable();
  };

  // The listening runtime disables Bun's idle timeout; the session's own pings
  // are what notice a frozen peer and close the cached connection. A close the
  // hub asked for is not worth a line — `notified` is already set by then.
  hub.session.onClose((closure) => {
    if (!notified) {
      logger.warn('connection_closed', {
        environmentId: definition.id,
        code: closure.code ?? null,
        reason: closure.reason ?? null,
      });
    }
    notifyGone();
  });

  return {
    client: new RuntimeClient(hub, notifyGone, definition.id),
    close(reason) {
      notified = true;
      hub.close(
        reason === 'superseded' ? CLOSE_CODES.SUPERSEDED : CLOSE_CODES.RELEASED,
        reason === 'superseded' ? 'Superseded' : 'Released'
      );
    },
  };
}

/** Dials the runtime under a deadline and exchanges hellos over what comes back. */
async function openRuntimeSession(wsUrl: string, token: string): Promise<ProtocolHubSession> {
  const deadline = dialDeadline(
    HANDSHAKE_TIMEOUT_MS,
    `The runtime did not accept a WebSocket at ${wsUrl} within ${HANDSHAKE_TIMEOUT_MS}ms.`
  );
  let port: Port;
  try {
    port = await connectWebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: deadline.signal,
    });
  } finally {
    deadline.clear();
  }
  return await openHubSession(port, {
    hubVersion: getVersion(),
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    requireMatchingRelease: false,
  });
}

/**
 * The rejection the connection manager reads.
 *
 * A `RemoteError` passes through untouched: `openHubSession` already answers
 * `UNAVAILABLE` for a peer that never spoke, and downgrading its
 * `PROTOCOL_MISMATCH` would stop the manager latching a retry deadline on it.
 * Everything else is a dial that never became a session, which is the same
 * `UNAVAILABLE` with the transport's own sentence kept intact.
 */
function asConnectError(error: unknown, environmentId: string, baseUrl: string): RemoteError {
  if (error instanceof RemoteError) return error;
  return new RemoteError(
    RESERVED_ERROR_CODES.UNAVAILABLE,
    `Environment "${environmentId}" could not open a runtime session at ${baseUrl}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { environmentId, baseUrl }
  );
}
