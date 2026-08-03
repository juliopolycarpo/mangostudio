/**
 * Runtime install/upgrade/reinstall runs with an SSE log stream.
 *
 * Mirrors {@link install-service}'s EventBuffer / recentStreams shape so the
 * frontend can reuse the install console parser. One active run per
 * environment; progress bytes from {@link pushRuntimeBinary} land as log lines.
 */

import type {
  InstallStreamEvent,
  RuntimeLifecycleStartResponse,
  RuntimeLifecycleView,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getVersion } from '../../../lib/config';
import {
  getRuntimeConnectionManager,
  type RuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { generateId } from '../../../utils/id';
import { environmentConfigFor } from '../domain/environment-config';
import { buildRuntimeLifecycleView, healthHasRuntime } from '../domain/runtime-lifecycle-view';
import { environmentRepository } from '../infrastructure/environment-repository';
import {
  type WslProvisioner,
  WslProvisioningError,
  wslProvisioner,
} from '../infrastructure/wsl-provisioner';

const MAX_RECENT_STREAMS = 20;

interface EventBuffer {
  readonly events: InstallStreamEvent[];
  readonly closed: boolean;
  publish(event: InstallStreamEvent): void;
  close(): void;
  subscribe(): AsyncIterableIterator<InstallStreamEvent>;
}

interface ActiveRun {
  readonly runId: string;
  readonly userId: string;
  readonly environmentId: string;
  readonly startedAt: number;
  readonly stream: EventBuffer;
  readonly abort: AbortController;
}

export class RuntimeLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLifecycleConflictError';
  }
}

export class RuntimeLifecycleUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 400 = 404
  ) {
    super(message);
    this.name = 'RuntimeLifecycleUnavailableError';
  }
}

export interface RuntimeLifecycleService {
  getView(userId: string, environmentId: string): Promise<RuntimeLifecycleView>;
  startInstall(userId: string, environmentId: string): Promise<RuntimeLifecycleStartResponse>;
  getRunStream(runId: string, userId: string): Promise<AsyncIterable<InstallStreamEvent> | null>;
  cancel(runId: string, userId: string): Promise<boolean>;
}

export interface RuntimeLifecycleServiceDeps {
  readonly manager?: RuntimeConnectionManager;
  readonly provisioner?: WslProvisioner;
  readonly now?: () => number;
}

function createEventBuffer(): EventBuffer {
  const events: InstallStreamEvent[] = [];
  const waiters = new Set<() => void>();
  let closed = false;

  const wake = () => {
    const pending = [...waiters];
    waiters.clear();
    for (const waiter of pending) waiter();
  };

  return {
    events,
    get closed() {
      return closed;
    },
    publish(event) {
      if (closed) return;
      events.push(event);
      wake();
    },
    close() {
      if (closed) return;
      closed = true;
      wake();
    },
    subscribe() {
      let cursor = 0;
      let ended = false;
      const pending = new Map<() => void, (result: IteratorResult<InstallStreamEvent>) => void>();
      const done = (): IteratorReturnResult<undefined> => ({ done: true, value: undefined });
      const read = (): IteratorResult<InstallStreamEvent> | null => {
        if (ended) return done();
        if (cursor < events.length) {
          const event = events[cursor] as InstallStreamEvent;
          cursor += 1;
          return { done: false, value: event };
        }
        if (!closed) return null;
        ended = true;
        return done();
      };

      const iterator: AsyncIterableIterator<InstallStreamEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        next() {
          const result = read();
          if (result) return Promise.resolve(result);

          return new Promise((resolve) => {
            const waiter = () => {
              const pendingResolve = pending.get(waiter);
              if (!pendingResolve) return;
              const next = read();
              if (!next) {
                waiters.add(waiter);
                return;
              }
              pending.delete(waiter);
              pendingResolve(next);
            };
            pending.set(waiter, resolve);
            waiters.add(waiter);
          });
        },
        return() {
          ended = true;
          const result = done();
          for (const [waiter, resolve] of pending) {
            waiters.delete(waiter);
            resolve(result);
          }
          pending.clear();
          return Promise.resolve(result);
        },
      };
      return iterator;
    },
  };
}

export function createRuntimeLifecycleService(
  overrides: RuntimeLifecycleServiceDeps = {}
): RuntimeLifecycleService {
  const manager = overrides.manager ?? getRuntimeConnectionManager();
  const provisioner = overrides.provisioner ?? wslProvisioner;
  const now = overrides.now ?? Date.now;

  const activeByEnvironment = new Map<string, ActiveRun>();
  const activeByRun = new Map<string, ActiveRun>();
  const recentStreams = new Map<string, { userId: string; stream: EventBuffer }>();

  const rememberStream = (runId: string, userId: string, stream: EventBuffer): void => {
    recentStreams.set(runId, { userId, stream });
    if (recentStreams.size <= MAX_RECENT_STREAMS) return;
    for (const [candidateId, candidate] of recentStreams) {
      if (!candidate.stream.closed || activeByRun.has(candidateId)) continue;
      recentStreams.delete(candidateId);
      if (recentStreams.size <= MAX_RECENT_STREAMS) break;
    }
  };

  const finish = (
    run: ActiveRun,
    status: Extract<InstallStreamEvent, { type: 'exit' }>['status'],
    code: number | null
  ): void => {
    if (run.stream.closed) return;
    run.stream.publish({
      type: 'exit',
      code,
      status,
      truncated: false,
      durationMs: Math.max(0, now() - run.startedAt),
      done: true,
    });
    run.stream.close();
    activeByEnvironment.delete(run.environmentId);
    activeByRun.delete(run.runId);
    rememberStream(run.runId, run.userId, run.stream);
  };

  return {
    async getView(userId, environmentId) {
      if (environmentId !== LOCAL_ENVIRONMENT_ID) {
        const record = await environmentRepository.find(userId, environmentId);
        if (!record) {
          throw new RuntimeLifecycleUnavailableError(
            `Environment "${environmentId}" was not found.`
          );
        }
      }

      const status = manager.getStatus(userId, environmentId);
      if (status.state === 'connected') {
        // Prefer a fresh health read so the panel shows version/digest rather
        // than waiting for the background freshness window.
        await manager.refreshManifest(userId, environmentId).catch(() => undefined);
      }

      const cached = manager.getCachedHealth(userId, environmentId);
      const transportKind =
        environmentId === LOCAL_ENVIRONMENT_ID
          ? 'in-process'
          : ((await environmentRepository.find(userId, environmentId))?.transportKind ?? 'stdio');

      const platformHint =
        cached?.health.platform && cached.health.arch
          ? `${cached.health.platform}-${cached.health.arch}`
          : undefined;

      return buildRuntimeLifecycleView({
        transportKind,
        health: cached?.health ?? null,
        readAtMs: cached?.readAtMs ?? null,
        connected: status.state === 'connected',
        nowMs: now(),
        platformHint,
      });
    },

    async startInstall(userId, environmentId) {
      if (environmentId === LOCAL_ENVIRONMENT_ID) {
        throw new RuntimeLifecycleUnavailableError(
          'The Local environment ships with MangoStudio; it cannot be installed from the card.',
          409
        );
      }

      const record = await environmentRepository.find(userId, environmentId);
      if (!record) {
        throw new RuntimeLifecycleUnavailableError(`Environment "${environmentId}" was not found.`);
      }

      if (record.transportKind !== 'wsl' && record.transportKind !== 'ssh') {
        throw new RuntimeLifecycleUnavailableError(
          `Runtime install from the card is not available for ${record.transportKind} environments.`,
          409
        );
      }

      // SSH push lands in the next commit; refuse clearly until then.
      if (record.transportKind === 'ssh') {
        throw new RuntimeLifecycleUnavailableError(
          'SSH runtime push is not available yet on this release.',
          409
        );
      }

      if (activeByEnvironment.has(environmentId)) {
        throw new RuntimeLifecycleConflictError(
          `A runtime install is already running for environment "${environmentId}".`
        );
      }

      const config = environmentConfigFor(record.transportKind, record.config);
      if (record.transportKind !== 'wsl' || !('distro' in config)) {
        throw new RuntimeLifecycleUnavailableError(
          `Environment "${environmentId}" has no WSL distribution configured.`
        );
      }
      const distro = config.distro;

      const runId = generateId();
      const stream = createEventBuffer();
      const abort = new AbortController();
      const run: ActiveRun = {
        runId,
        userId,
        environmentId,
        startedAt: now(),
        stream,
        abort,
      };
      activeByEnvironment.set(environmentId, run);
      activeByRun.set(runId, run);
      rememberStream(runId, userId, stream);

      const cached = manager.getCachedHealth(userId, environmentId);
      const action = healthHasRuntime(cached?.health ?? null) ? 'reinstall' : 'install';
      stream.publish({
        type: 'log',
        stream: 'system',
        line: `Starting runtime ${action} for "${distro}" (hub ${getVersion()}).`,
        done: false,
      });

      void (async () => {
        try {
          if (abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          await provisioner.ensure(distro);
          if (abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          stream.publish({
            type: 'log',
            stream: 'system',
            line: `Runtime ${action} finished for "${distro}".`,
            done: false,
          });
          // Refresh so the panel picks up the new health without waiting.
          await manager
            .connect(userId, environmentId, { force: true })
            .then(() => manager.refreshManifest(userId, environmentId))
            .catch(() => undefined);
          finish(run, 'succeeded', 0);
        } catch (error) {
          if (abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          const detail =
            error instanceof WslProvisioningError || error instanceof Error
              ? error.message
              : String(error);
          stream.publish({
            type: 'log',
            stream: 'stderr',
            line: detail,
            done: false,
          });
          finish(run, 'failed', 1);
        }
      })();

      return { runId };
    },

    getRunStream(runId, userId) {
      const active = activeByRun.get(runId);
      if (active) {
        if (active.userId !== userId) return Promise.resolve(null);
        return Promise.resolve(active.stream.subscribe());
      }
      const recent = recentStreams.get(runId);
      if (!recent || recent.userId !== userId) return Promise.resolve(null);
      return Promise.resolve(recent.stream.subscribe());
    },

    cancel(runId, userId) {
      const run = activeByRun.get(runId);
      if (!run || run.userId !== userId) return Promise.resolve(false);
      run.abort.abort();
      finish(run, 'cancelled', null);
      return Promise.resolve(true);
    },
  };
}

export const runtimeLifecycleService = createRuntimeLifecycleService();
