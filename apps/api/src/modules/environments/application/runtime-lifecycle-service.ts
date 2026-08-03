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
  RuntimeSetupBody,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';
import { getVersion } from '../../../lib/config';
import {
  getRuntimeConnectionManager,
  type RuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { generateId } from '../../../utils/id';
import { environmentConfigFor } from '../domain/environment-config';
import { buildRuntimeLifecycleView, healthHasRuntime } from '../domain/runtime-lifecycle-view';
import { pushRuntimeBinary, RuntimePushError } from '../domain/runtime-push';
import { loadRuntimeReleaseBytes, RuntimeAssetLoadError } from '../domain/runtime-release-fetch';
import { PLATFORM_PROBE_SCRIPT } from '../domain/wsl-runtime-release';
import { environmentRepository } from '../infrastructure/environment-repository';
import { createSshCommandRunner } from '../infrastructure/ssh-command-runner';
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
  startSetup(
    userId: string,
    environmentId: string,
    body: RuntimeSetupBody
  ): Promise<RuntimeLifecycleView>;
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

      if (activeByEnvironment.has(environmentId)) {
        throw new RuntimeLifecycleConflictError(
          `A runtime install is already running for environment "${environmentId}".`
        );
      }

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
      const targetLabel =
        record.transportKind === 'wsl'
          ? environmentConfigFor('wsl', record.config).distro
          : environmentConfigFor('ssh', record.config).host;

      stream.publish({
        type: 'log',
        stream: 'system',
        line: `Starting runtime ${action} for "${targetLabel}" (hub ${getVersion()}).`,
        done: false,
      });

      void (async () => {
        try {
          if (abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          if (record.transportKind === 'wsl') {
            await provisioner.ensure(environmentConfigFor('wsl', record.config).distro);
          } else {
            await pushOverSsh(record.config, stream, abort.signal);
          }
          if (abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          stream.publish({
            type: 'log',
            stream: 'system',
            line: `Runtime ${action} finished for "${targetLabel}".`,
            done: false,
          });
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
            error instanceof WslProvisioningError ||
            error instanceof RuntimePushError ||
            error instanceof RuntimeAssetLoadError ||
            error instanceof Error
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

    async startSetup(userId, environmentId, body) {
      if (environmentId === LOCAL_ENVIRONMENT_ID) {
        throw new RuntimeLifecycleUnavailableError(
          'Local consent is recorded on this machine with mangostudio-runtime setup.',
          409
        );
      }
      const record = await environmentRepository.find(userId, environmentId);
      if (!record) {
        throw new RuntimeLifecycleUnavailableError(`Environment "${environmentId}" was not found.`);
      }
      if (record.transportKind !== 'ssh') {
        throw new RuntimeLifecycleUnavailableError(
          'Setup-over-ssh is only available for SSH environments.',
          409
        );
      }

      const config = environmentConfigFor('ssh', record.config);
      const runner = createSshCommandRunner(config);
      const allow = resolveSetupAllow(body);

      // Code-defined scripts; values travel as $1. `custom` is not a --profile
      // value — the CLI derives that name from any non-preset allow set.
      const result =
        body.profile === 'custom'
          ? await runner(
              'exec "$HOME"/.mango/runtime/remote/current/mangostudio-runtime setup --slot remote --allow "$1" --yes --json',
              {
                args: [
                  RUNTIME_CAPABILITY_KEYS.map(
                    (key) => `${key}=${allow[key] ? 'true' : 'false'}`
                  ).join(','),
                ],
                timeoutMs: 60_000,
              }
            )
          : await runner(
              'exec "$HOME"/.mango/runtime/remote/current/mangostudio-runtime setup --slot remote --profile "$1" --yes --json',
              { args: [body.profile], timeoutMs: 60_000 }
            );
      if (result.exitCode !== 0) {
        throw new RuntimeLifecycleUnavailableError(
          `Setup on "${config.host}" failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
          409
        );
      }

      await manager
        .connect(userId, environmentId, { force: true })
        .then(() => manager.refreshManifest(userId, environmentId))
        .catch(() => undefined);
      return this.getView(userId, environmentId);
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

async function pushOverSsh(
  configUnknown: unknown,
  stream: EventBuffer,
  signal: AbortSignal
): Promise<void> {
  const config = environmentConfigFor('ssh', configUnknown);
  const runner = createSshCommandRunner(config);
  const probe = await runner(PLATFORM_PROBE_SCRIPT, { timeoutMs: 30_000 });
  if (probe.exitCode !== 0) {
    throw new RuntimePushError(
      `Could not probe "${config.host}": ${probe.stderr.trim() || probe.stdout.trim() || `exit ${probe.exitCode}`}`
    );
  }
  const lines = probe.stdout.trim().split(/\r?\n/);
  const platformProbe =
    lines.length >= 3
      ? { kernel: lines[0] ?? '', machine: lines[1] ?? '', libc: lines[2] ?? '' }
      : { kernel: 'Linux', machine: lines[0] ?? '', libc: lines[1] ?? '' };
  const platformId = resolveRuntimePlatformId(platformProbe);
  if (!platformId) {
    throw new RuntimePushError(
      `Could not tell which runtime build "${config.host}" needs (${platformProbe.kernel} ${platformProbe.machine}).`
    );
  }

  stream.publish({
    type: 'log',
    stream: 'system',
    line: `Resolved platform ${platformId}; loading release asset…`,
    done: false,
  });
  if (signal.aborted) return;

  const asset = await loadRuntimeReleaseBytes(platformId);
  const total = asset.bytes.byteLength;
  let lastPct = -1;
  await pushRuntimeBinary({
    runner,
    slot: 'remote',
    version: getVersion(),
    bytes: asset.bytes,
    fromArchive: asset.fromArchive,
    timeoutMs: 600_000,
    onStdinProgress: (written) => {
      const pct = Math.min(100, Math.floor((written / total) * 100));
      if (pct === lastPct || pct % 5 !== 0) return;
      lastPct = pct;
      stream.publish({
        type: 'log',
        stream: 'stdout',
        line: `Transferred ${pct}% (${written}/${total} bytes)`,
        done: false,
      });
    },
  });
}

function resolveSetupAllow(body: RuntimeSetupBody): RuntimeCapabilityAllow {
  if (body.profile !== 'custom') {
    return RUNTIME_CONSENT_PRESETS[body.profile];
  }
  const base = RUNTIME_CONSENT_PRESETS.none;
  return Object.fromEntries(
    RUNTIME_CAPABILITY_KEYS.map((key) => [key, body.allow?.[key] ?? base[key]])
  ) as RuntimeCapabilityAllow;
}
