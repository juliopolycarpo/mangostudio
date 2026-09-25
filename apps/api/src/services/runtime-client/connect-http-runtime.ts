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
import { HUB_BINDING_KEY_HEADER } from '@mangostudio/shared/runtime-contract';
import { dialDeadline } from '@mangostudio/shared/utils/dial-deadline';
import { getVersion } from '../../lib/config';
import { createDiagnosticLogger } from '../../lib/logger';
import { environmentConfigFor } from '../../modules/environments/domain/environment-config';
import { resolveRemoteHandshakeTimeoutMs } from './handshake-budget';
import { httpRuntimeBaseUrlToWebSocketUrl } from './http-runtime-url';
import { hubBindingKeyFor } from './hub-binding-key';
import { openHubSession, type ProtocolHubSession } from './hub-session';
import type { HubWorkspaceBinding } from './hub-workspace-authority';
import { RuntimeClient } from './runtime-client';
import { readRuntimeToken } from './runtime-token-secrets';

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

/**
 * What the attempt gives this dial. Structurally the manager's connect
 * context, kept local for the same reason {@link HttpRuntimeDefinition} is.
 */
export interface HttpConnectContext {
  /**
   * Aborted when the attempt is released. Ends the WebSocket dial or the
   * handshake at once, closes the socket, and rejects with `CANCELLED`.
   */
  readonly signal?: AbortSignal;
}

/**
 * Dials a runtime listening with `mangostudio-runtime serve` and handshakes.
 *
 * @example
 * const connection = await connectHttpRuntime(definition, markUnavailable, { signal });
 */
export async function connectHttpRuntime(
  definition: HttpRuntimeDefinition,
  onUnavailable: () => void,
  context: HttpConnectContext = {}
): Promise<HttpRuntimeConnection> {
  const { baseUrl } = environmentConfigFor('http', definition.config);
  const wsUrl = httpRuntimeBaseUrlToWebSocketUrl(baseUrl);
  const token = await readRuntimeToken(definition.userId, definition.id);

  let hub: ProtocolHubSession;
  try {
    hub = await openRuntimeSession(
      wsUrl,
      token,
      { userId: definition.userId, environmentId: definition.id },
      context.signal
    );
  } catch (error) {
    if (context.signal?.aborted) throw cancelled(definition.id);
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

/**
 * The upgrade request headers for a `serve` runtime: the bearer credential,
 * and the binding key of the environment record this connection speaks for.
 *
 * The key rides beside the credential because that is where the runtime
 * decides admission — before either side's `hello`. A runtime already holding
 * a live connection for another record refuses this one with
 * `RUNTIME_ALREADY_BOUND_CLOSE_CODE` instead of superseding it.
 *
 * @example
 * runtimeUpgradeHeaders('s3cret', { userId: 'u1', environmentId: 'lan-box' });
 * // { authorization: 'Bearer s3cret', 'x-mangostudio-hub-binding': '<64 hex>' }
 */
export function runtimeUpgradeHeaders(
  token: string,
  binding: HubWorkspaceBinding
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    [HUB_BINDING_KEY_HEADER]: hubBindingKeyFor(binding),
  };
}

/** Dials the runtime under a deadline and exchanges hellos over what comes back. */
async function openRuntimeSession(
  wsUrl: string,
  token: string,
  workspaceBinding: HubWorkspaceBinding,
  signal: AbortSignal | undefined
): Promise<ProtocolHubSession> {
  // One budget for the dial and the hello after it; see `resolveRemoteHandshakeTimeoutMs`.
  const timeoutMs = resolveRemoteHandshakeTimeoutMs('http');
  const deadline = dialDeadline(
    timeoutMs,
    `The runtime did not accept a WebSocket at ${wsUrl} within ${timeoutMs}ms.`
  );
  let port: Port;
  try {
    port = await connectWebSocket(wsUrl, {
      headers: runtimeUpgradeHeaders(token, workspaceBinding),
      // `connectWebSocket` closes the half-open socket on either abort.
      signal: signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal,
    });
  } finally {
    deadline.clear();
  }
  return await openHubSession(port, {
    hubVersion: getVersion(),
    handshakeTimeoutMs: timeoutMs,
    requireMatchingRelease: false,
    workspaceBinding,
    ...(signal ? { signal } : {}),
  });
}

/** What a dial released before it finished handshaking rejects with. */
function cancelled(environmentId: string): RemoteError {
  return new RemoteError(
    RESERVED_ERROR_CODES.CANCELLED,
    `The connection to environment "${environmentId}" was cancelled before it finished handshaking.`
  );
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
