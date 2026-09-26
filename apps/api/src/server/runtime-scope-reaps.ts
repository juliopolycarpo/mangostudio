/**
 * The server's reactions to a runtime scope going away: withdrawn consent, a
 * withdrawn terminal capability, or the user's own Disconnect/removal.
 */

import { createDiagnosticLogger, type DiagnosticLogger } from '../lib/logger';
import type { EnvironmentWithdrawnListener } from '../modules/environments/application/environment-service';
import type { ExternalSessionManager } from '../modules/external-agents/application/external-session-manager';
import type { TerminalSessionService } from '../modules/terminals/application/terminal-session-service';
import type { RuntimeConnectionManager } from '../services/runtime-client/runtime-connection-manager';

export interface RuntimeScopeReapDeps {
  readonly manager: Pick<
    RuntimeConnectionManager,
    'onExternalAgentsRevoked' | 'onTerminalsRevoked'
  >;
  readonly onEnvironmentWithdrawn: (listener: EnvironmentWithdrawnListener) => () => void;
  readonly sessions: Pick<ExternalSessionManager, 'reapScope'>;
  readonly logger?: Pick<DiagnosticLogger, 'warn'>;
  readonly terminals: Pick<TerminalSessionService, 'revokeScope'>;
}

/**
 * Subscribes the session and terminal reaps to every scope-withdrawal signal,
 * and returns the matching unsubscribe. Calling it again without unsubscribing
 * first would reap every withdrawn scope twice, so the server keeps the
 * returned function and calls it on shutdown.
 *
 * @example
 * const stop = subscribeRuntimeScopeReaps({ manager, onEnvironmentWithdrawn, sessions, terminals });
 * stop();
 */
export function subscribeRuntimeScopeReaps(deps: RuntimeScopeReapDeps): () => void {
  const logger = deps.logger ?? createDiagnosticLogger('runtime-scope-reaps');
  // A peer that withdraws external-agent consent closes its vendor sessions
  // without saying so on the wire, so the hub learns it from the next manifest
  // refresh. Without this the chats it was running would keep a session the
  // runtime no longer has, and their turns would wait on events that stopped.
  deps.manager.onExternalAgentsRevoked((userId, environmentId) => {
    void deps.sessions
      .reapScope({ userId, environmentId }, 'consent-revoked')
      .catch((error: unknown) => {
        logger.warn('reap_failed', {
          userId,
          environmentId,
          reason: 'consent-revoked',
          error: String(error),
        });
      });
  });
  // A turn waiting to resubmit reconnects on its own after a dropped socket;
  // after the user's own Disconnect, disable, repoint or removal it must not.
  const stopWithdrawn = deps.onEnvironmentWithdrawn((userId, environmentId) => {
    void deps.sessions
      .reapScope({ userId, environmentId }, 'runtime-disconnected', {
        keepContinuation: true,
        explicit: true,
      })
      .catch((error: unknown) => {
        logger.warn('reap_failed', {
          userId,
          environmentId,
          reason: 'runtime-disconnected',
          error: String(error),
        });
      });
  });
  deps.manager.onTerminalsRevoked((userId, environmentId) => {
    deps.terminals.revokeScope(userId, environmentId);
  });
  return () => {
    stopWithdrawn();
    deps.manager.onExternalAgentsRevoked(undefined);
    deps.manager.onTerminalsRevoked(undefined);
  };
}
