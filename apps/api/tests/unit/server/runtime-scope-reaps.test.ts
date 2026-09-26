import { describe, expect, it } from 'bun:test';
import type { LogMetadata } from '../../../src/lib/logger';
import type { EnvironmentWithdrawnListener } from '../../../src/modules/environments/application/environment-service';
import {
  type RuntimeScopeReapDeps,
  subscribeRuntimeScopeReaps,
} from '../../../src/server/runtime-scope-reaps';

type ScopeObserver = ((userId: string, environmentId: string) => void) | undefined;

/** The connection manager's two single-slot observers, as the server sees them. */
class FakeRevocationSource {
  externalAgents: ScopeObserver;
  terminals: ScopeObserver;
  onExternalAgentsRevoked(observer: ScopeObserver): void {
    this.externalAgents = observer;
  }
  onTerminalsRevoked(observer: ScopeObserver): void {
    this.terminals = observer;
  }
}

/** `onEnvironmentWithdrawn`'s listener set. */
class FakeWithdrawnSignal {
  readonly listeners = new Set<EnvironmentWithdrawnListener>();
  readonly subscribe = (listener: EnvironmentWithdrawnListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(userId: string, environmentId: string): void {
    for (const listener of this.listeners) listener(userId, environmentId);
  }
}

/** Records every reap and revoke it is asked for. */
class RecordingReaper {
  readonly reaps: string[] = [];
  readonly revokes: string[] = [];
  failure: Error | undefined;
  reapScope(scope: { userId?: string; environmentId?: string }, reason: string): Promise<void> {
    this.reaps.push(`${scope.userId}:${scope.environmentId}:${reason}`);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve();
  }
  revokeScope(userId: string, environmentId: string): void {
    this.revokes.push(`${userId}:${environmentId}`);
  }
}

class RecordingLogger {
  readonly warnings: { event: string; metadata: LogMetadata | undefined }[] = [];
  warn(event: string, metadata?: LogMetadata): void {
    this.warnings.push({ event, metadata });
  }
}

function wire() {
  const manager = new FakeRevocationSource();
  const withdrawn = new FakeWithdrawnSignal();
  const reaper = new RecordingReaper();
  const logger = new RecordingLogger();
  const deps: RuntimeScopeReapDeps = {
    manager,
    onEnvironmentWithdrawn: withdrawn.subscribe,
    sessions: reaper,
    terminals: reaper,
    logger,
  };
  return { deps, manager, withdrawn, reaper, logger };
}

describe('subscribeRuntimeScopeReaps', () => {
  it('reaps each withdrawal signal once, with its own reason', () => {
    const { deps, manager, withdrawn, reaper } = wire();
    subscribeRuntimeScopeReaps(deps);

    manager.externalAgents?.('u1', 'devbox');
    withdrawn.emit('u1', 'local');
    manager.terminals?.('u2', 'devbox');

    expect(reaper.reaps).toEqual(['u1:devbox:consent-revoked', 'u1:local:runtime-disconnected']);
    expect(reaper.revokes).toEqual(['u2:devbox']);
  });

  it('leaves no listener behind once unsubscribed, so a restart does not reap twice', () => {
    const { deps, withdrawn, reaper } = wire();

    subscribeRuntimeScopeReaps(deps)();
    subscribeRuntimeScopeReaps(deps);
    withdrawn.emit('u1', 'local');

    expect(withdrawn.listeners.size).toBe(1);
    expect(reaper.reaps).toEqual(['u1:local:runtime-disconnected']);
  });

  it('logs failed reaps with the affected scope and reason', async () => {
    const { deps, manager, withdrawn, reaper, logger } = wire();
    reaper.failure = new Error('SQLite is busy');
    const stop = subscribeRuntimeScopeReaps(deps);

    manager.externalAgents?.('u1', 'devbox');
    withdrawn.emit('u2', 'local');
    await Promise.resolve();

    expect(logger.warnings).toEqual([
      {
        event: 'reap_failed',
        metadata: {
          userId: 'u1',
          environmentId: 'devbox',
          reason: 'consent-revoked',
          error: 'Error: SQLite is busy',
        },
      },
      {
        event: 'reap_failed',
        metadata: {
          userId: 'u2',
          environmentId: 'local',
          reason: 'runtime-disconnected',
          error: 'Error: SQLite is busy',
        },
      },
    ]);
    stop();
  });

  it('clears both manager observers on unsubscribe', () => {
    const { deps, manager } = wire();

    subscribeRuntimeScopeReaps(deps)();

    expect(manager.externalAgents).toBeUndefined();
    expect(manager.terminals).toBeUndefined();
  });
});
