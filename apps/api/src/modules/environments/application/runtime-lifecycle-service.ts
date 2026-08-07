/**
 * Runtime install/upgrade/reinstall runs with an SSE log stream.
 *
 * Mirrors {@link install-service}'s EventBuffer / recentStreams shape so the
 * frontend can reuse the install console parser. One active run per
 * environment; progress bytes from {@link pushRuntimeBinary} land as log lines.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type {
  EnvironmentTransportKind,
  InstallStreamEvent,
  RuntimeLifecycleInstallBody,
  RuntimeLifecycleStartResponse,
  RuntimeLifecycleView,
  RuntimePairedBootstrapBody,
  RuntimeSetupBody,
  RuntimeStagedAsset,
  SshEnvironmentConfig,
} from '@mangostudio/shared/environments';
import {
  DEFAULT_SSH_RUNTIME_PATH,
  LOCAL_ENVIRONMENT_ID,
  sshRuntimePath,
} from '@mangostudio/shared/environments';
import {
  PLATFORM_PROBE_SCRIPT,
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeHealthReport,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';
import { getConfig, getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import {
  getRuntimeConnectionManager,
  type RuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { generateId } from '../../../utils/id';
import { environmentConfigFor } from '../domain/environment-config';
import { runtimeDialEndpoint } from '../domain/pairing-token';
import {
  buildConnectBootstrapCommand,
  buildServiceInstallCommand,
  RESOLVE_RUNTIME_PATH,
} from '../domain/remote-bootstrap-commands';
import {
  buildRuntimeLifecycleView,
  canUpdateOverLiveConnection,
  stagedRuntimeAsset,
} from '../domain/runtime-lifecycle-view';
import { streamRuntimeUpdate } from '../domain/runtime-live-update';
import {
  pushRuntimeBinary,
  type RuntimeCommandResult,
  type RuntimeCommandRunner,
  RuntimePushError,
  runtimeSlotBytesScript,
  runtimeVersionScript,
} from '../domain/runtime-push';
import {
  type LoadedRuntimeAsset,
  loadRuntimeReleaseBytes,
  pinnedRuntimeDigest,
  RuntimeAssetLoadError,
  runtimeDigestSidecarPath,
} from '../domain/runtime-release-fetch';
import { classifySshFailure, describeSshFailure } from '../domain/ssh-failure';
import {
  type EnvironmentRecord,
  environmentRepository,
} from '../infrastructure/environment-repository';
import { createSshCommandRunner } from '../infrastructure/ssh-command-runner';
import {
  type WslProvisioner,
  WslProvisioningError,
  wslProvisioner,
} from '../infrastructure/wsl-provisioner';
import { type RuntimePairingService, runtimePairingService } from './runtime-pairing-service';

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

interface RuntimeLifecycleViewOptions {
  /**
   * Reads the slot's byte size for the removal dialog's byte count. Off by
   * default: a WSL read boots a stopped distribution, which is fine for a
   * deliberate "how much would removing this free" click but not for the
   * panel's 15s poll (`docs`: `readSlotBytes`).
   */
  readonly includeSlotBytes?: boolean;
}

export interface RuntimeLifecycleService {
  getView(
    userId: string,
    environmentId: string,
    options?: RuntimeLifecycleViewOptions
  ): Promise<RuntimeLifecycleView>;
  startInstall(
    userId: string,
    environmentId: string,
    body: RuntimeLifecycleInstallBody
  ): Promise<RuntimeLifecycleStartResponse>;
  startSetup(
    userId: string,
    environmentId: string,
    body: RuntimeSetupBody
  ): Promise<RuntimeLifecycleView>;
  /**
   * Provisions an ssh-reachable machine so it dials this hub over WebSocket:
   * push, consent, credential, service. See {@link runPairedBootstrap}.
   */
  startPairedBootstrap(
    userId: string,
    environmentId: string,
    body: RuntimePairedBootstrapBody
  ): Promise<RuntimeLifecycleStartResponse>;
  getRunStream(runId: string, userId: string): Promise<AsyncIterable<InstallStreamEvent> | null>;
  cancel(runId: string, userId: string): Promise<boolean>;
  hasActiveInstall(userId: string, environmentId: string): boolean;
}

export interface RuntimeLifecycleServiceDeps {
  readonly manager?: RuntimeConnectionManager;
  readonly provisioner?: WslProvisioner;
  readonly now?: () => number;
  readonly loadRuntimeAsset?: (
    platformId: string,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<LoadedRuntimeAsset>;
  /** Mints the credential the bootstrapped machine dials back with. */
  readonly pairing?: RuntimePairingService;
  /** Read per call, not per construction: config reloads without a restart. */
  readonly publicUrl?: () => string;
  /** Builds the ssh channel for a bootstrap; injected so tests never spawn ssh. */
  readonly commandRunner?: (config: SshEnvironmentConfig) => RuntimeCommandRunner;
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
  const loadRuntimeAsset = overrides.loadRuntimeAsset ?? loadRuntimeReleaseBytes;
  const pairing = overrides.pairing ?? runtimePairingService;
  const publicUrl = overrides.publicUrl ?? (() => getConfig().server.publicUrl);
  const commandRunner = overrides.commandRunner ?? createSshCommandRunner;

  const activeByEnvironment = new Map<string, ActiveRun>();
  const activeByRun = new Map<string, ActiveRun>();
  const recentStreams = new Map<string, { userId: string; stream: EventBuffer }>();

  const installKey = (userId: string, environmentId: string): string =>
    `${userId}:${environmentId}`;

  const rememberStream = (runId: string, userId: string, stream: EventBuffer): void => {
    recentStreams.set(runId, { userId, stream });
    if (recentStreams.size <= MAX_RECENT_STREAMS) return;
    for (const [candidateId, candidate] of recentStreams) {
      if (!candidate.stream.closed || activeByRun.has(candidateId)) continue;
      recentStreams.delete(candidateId);
      if (recentStreams.size <= MAX_RECENT_STREAMS) break;
    }
  };

  /** Registers a new streamed run as the one active run for its environment. */
  const beginRun = (userId: string, environmentId: string): ActiveRun => {
    const run: ActiveRun = {
      runId: generateId(),
      userId,
      environmentId,
      startedAt: now(),
      stream: createEventBuffer(),
      abort: new AbortController(),
    };
    activeByEnvironment.set(installKey(userId, environmentId), run);
    activeByRun.set(run.runId, run);
    rememberStream(run.runId, userId, run.stream);
    return run;
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
    activeByEnvironment.delete(installKey(run.userId, run.environmentId));
    activeByRun.delete(run.runId);
    rememberStream(run.runId, run.userId, run.stream);
  };

  /**
   * Fetches and verifies the matching runtime into the hub's cache, and stops.
   *
   * Nothing here touches the target machine, which is the point: it is the
   * half of a provision that is worth keeping when somebody declines the other
   * half. The bytes are checksum-verified against the release on the way in —
   * an unverified download left on disk with a path printed next to it would be
   * worse than no download at all.
   */
  const startStagedDownload = (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly transportKind: EnvironmentTransportKind;
    readonly health: RuntimeHealthReport | null;
  }): RuntimeLifecycleStartResponse => {
    const { userId, environmentId } = input;
    if (input.transportKind !== 'wsl' && input.transportKind !== 'ssh') {
      throw new RuntimeLifecycleUnavailableError(
        `Staging a runtime download is not available for ${input.transportKind} environments. The hub does not install to them, so a copy in its cache would move nothing closer to that machine.`,
        409
      );
    }
    if (isDevelopmentVersion(getVersion())) {
      throw new RuntimeLifecycleUnavailableError(
        'This MangoStudio runs from a source checkout, so no release publishes a runtime to download. Build one from the repository root instead.',
        409
      );
    }

    const staged = stagedRuntimeAssetFor(input.transportKind, input.health);
    if (!staged) {
      throw new RuntimeLifecycleUnavailableError(
        'This hub does not know which build that machine needs yet. Connect it once so it reports its platform, then download the matching runtime.',
        409
      );
    }

    if (activeByEnvironment.has(installKey(userId, environmentId))) {
      throw new RuntimeLifecycleConflictError(
        `A runtime install is already running for environment "${environmentId}".`
      );
    }

    const run = beginRun(userId, environmentId);
    const { runId, stream, abort } = run;

    stream.publish({
      type: 'log',
      stream: 'system',
      line: `Downloading ${staged.assetName} into the hub cache. Nothing is written to the target machine.`,
      done: false,
    });

    void (async () => {
      try {
        const asset = await loadRuntimeAsset(staged.platformId, { signal: abort.signal });
        if (abort.signal.aborted) {
          finish(run, 'cancelled', null);
          return;
        }

        if (!asset.cached) {
          stream.publish({
            type: 'log',
            stream: 'stderr',
            line: `Verified ${staged.assetName} but could not write it to ${runtimeCacheDir(staged.version)}. Nothing is staged at ${staged.path}; check that the cache directory is writable and retry.`,
            done: false,
          });
          finish(run, 'failed', 1);
          return;
        }

        // Describes what the cache actually holds. A release that published no
        // raw runtime for this platform is served from its archive instead, so
        // the path and the checksum line have to name the archive — the raw
        // ones would point at a file that is not there. Pinned to the digest
        // this run just verified rather than reusing `staged.verify`: that was
        // built before the download, off whatever SHA256SUMS a rolling tag
        // served then, which is not necessarily the build these bytes are.
        const landed =
          stagedRuntimeAssetFor(input.transportKind, input.health, {
            fromArchive: asset.fromArchive,
            pinnedDigest: asset.digest.replace(/^sha256:/, ''),
          }) ?? staged;
        const line = asset.fromArchive
          ? `This release publishes no standalone runtime for ${staged.platformId}; its platform archive is cached at ${landed.path} instead.`
          : `Verified and cached at ${landed.path}`;
        stream.publish({ type: 'log', stream: 'system', line, done: false });
        stream.publish({ type: 'log', stream: 'system', line: landed.verify, done: false });
        finish(run, 'succeeded', 0);
      } catch (error) {
        if (abort.signal.aborted) {
          finish(run, 'cancelled', null);
          return;
        }
        stream.publish({
          type: 'log',
          stream: 'stderr',
          line: error instanceof Error ? error.message : String(error),
          done: false,
        });
        finish(run, 'failed', 1);
      }
    })();

    return { runId };
  };

  return {
    async getView(userId, environmentId, options) {
      const record =
        environmentId === LOCAL_ENVIRONMENT_ID
          ? null
          : await environmentRepository.find(userId, environmentId);
      if (environmentId !== LOCAL_ENVIRONMENT_ID && !record) {
        throw new RuntimeLifecycleUnavailableError(`Environment "${environmentId}" was not found.`);
      }

      const status = manager.getStatus(userId, environmentId);
      if (status.state === 'connected') {
        // Prefer a fresh health read so the panel shows version/digest rather
        // than waiting for the background freshness window.
        await manager.refreshManifest(userId, environmentId).catch(() => undefined);
      }

      const cached = manager.getCachedHealth(userId, environmentId);
      const transportKind =
        environmentId === LOCAL_ENVIRONMENT_ID ? 'in-process' : (record?.transportKind ?? 'stdio');

      const platformHint =
        cached?.health.platform && cached.health.arch
          ? `${cached.health.platform}-${cached.health.arch}`
          : undefined;

      const slotBytes =
        options?.includeSlotBytes && record
          ? await readSlotBytes(record, provisioner).catch(() => null)
          : null;

      const managedPush =
        transportKind !== 'ssh'
          ? true
          : !environmentConfigFor('ssh', record?.config).remoteRuntimePath?.trim();

      return buildRuntimeLifecycleView({
        transportKind,
        health: cached?.health ?? null,
        readAtMs: cached?.readAtMs ?? null,
        connected: status.state === 'connected',
        nowMs: now(),
        platformHint,
        slotBytes,
        managedPush,
        stagedRuntime: await resolveStagedRuntime(transportKind, cached?.health ?? null),
      });
    },

    async startInstall(userId, environmentId, body) {
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

      const action = body.action;
      const cached = manager.getCachedHealth(userId, environmentId);
      const status = manager.getStatus(userId, environmentId);
      const sshCustomPath =
        record.transportKind === 'ssh' &&
        Boolean(environmentConfigFor('ssh', record.config).remoteRuntimePath?.trim());
      const canPushOutOfBand = record.transportKind === 'wsl' || record.transportKind === 'ssh';

      // Staging stops before every gate below, because every gate below is
      // about writing to someone else's machine. This writes to the hub's own
      // cache and stops: no consent to honour, no push target to be wrong
      // about, and useful precisely when the push gates say no.
      if (action === 'download') {
        return startStagedDownload({
          userId,
          environmentId,
          transportKind: record.transportKind,
          health: cached?.health ?? null,
        });
      }

      const canUpdateLive =
        action === 'upgrade' &&
        cached !== null &&
        canUpdateOverLiveConnection({
          transportKind: record.transportKind,
          health: cached.health,
          connected: status.state === 'connected',
          managedPush: !sshCustomPath,
        });

      if (!canPushOutOfBand && !canUpdateLive) {
        throw new RuntimeLifecycleUnavailableError(
          `Runtime ${action} over the hub is not available for ${record.transportKind} environments. A connected, update-capable runtime can be upgraded in place.`,
          409
        );
      }

      if (sshCustomPath) {
        throw new RuntimeLifecycleUnavailableError(
          `This SSH environment uses a custom runtime path (${DEFAULT_SSH_RUNTIME_PATH} is the managed slot). Install or upgrade that binary on the host, or clear remoteRuntimePath to use hub-managed push.`,
          409
        );
      }

      // Every action here writes the same bytes through the same helper, so the
      // gate covers `install` too: leaving it open would make a machine's
      // "no hub-driven updates" answer one button-click wide. The push runs on
      // the user's own credentials out of band, where the runtime cannot refuse
      // it — this check is the enforcement, not a hint.
      if (cached?.health?.allow?.update === false) {
        throw new RuntimeLifecycleUnavailableError(
          'This machine denied hub-driven runtime updates (`allow.update`). Change consent with setup before installing, reinstalling or upgrading.',
          409
        );
      }

      if (activeByEnvironment.has(installKey(userId, environmentId))) {
        throw new RuntimeLifecycleConflictError(
          `A runtime install is already running for environment "${environmentId}".`
        );
      }

      const run = beginRun(userId, environmentId);
      const { runId, stream, abort } = run;

      const forceReplace = action === 'reinstall';
      const targetLabel =
        record.transportKind === 'wsl'
          ? environmentConfigFor('wsl', record.config).distro
          : record.transportKind === 'ssh'
            ? environmentConfigFor('ssh', record.config).host
            : record.name;

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
          if (canUpdateLive) {
            await updateOverLiveConnection({
              userId,
              environmentId,
              transportKind: record.transportKind,
              health: cached.health,
              manager,
              loadRuntimeAsset,
              stream,
              signal: abort.signal,
            });
          } else if (record.transportKind === 'wsl') {
            await provisioner.ensure(environmentConfigFor('wsl', record.config).distro, {
              signal: abort.signal,
              force: forceReplace,
              onTransferProgress: transferProgressPublisher(stream),
            });
          } else if (record.transportKind === 'ssh') {
            await pushOverSsh(record.config, stream, abort.signal, { force: forceReplace });
          } else {
            throw new RuntimeLifecycleUnavailableError(
              `Runtime ${action} is not available for ${record.transportKind} environments.`,
              409
            );
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
      const command = buildSetupCommand(body, allow, sshRuntimePath(config));
      const result = await runner(command.script, { args: command.args, timeoutMs: 60_000 });
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

    async startPairedBootstrap(userId, environmentId, body) {
      const record = await environmentRepository.find(userId, environmentId);
      if (!record) {
        throw new RuntimeLifecycleUnavailableError(`Environment "${environmentId}" was not found.`);
      }
      if (record.transportKind !== 'websocket') {
        throw new RuntimeLifecycleUnavailableError(
          'Bootstrapping over ssh applies to a paired environment; this one uses a different transport.',
          409
        );
      }
      // The push writes the managed slot and nothing else, so a custom path
      // would consent, pair and supervise a binary this run never installed.
      if (body.ssh.remoteRuntimePath?.trim()) {
        throw new RuntimeLifecycleUnavailableError(
          `Bootstrapping installs into the managed slot (${DEFAULT_SSH_RUNTIME_PATH}); it cannot target a custom runtime path.`,
          400
        );
      }
      const endpoint = runtimeDialEndpoint(publicUrl());
      if (!endpoint) {
        throw new RuntimeLifecycleUnavailableError(
          'MangoStudio does not know its own public address, so it cannot tell that machine where to dial. Set `publicUrl` under `[server]` in config.toml (or PUBLIC_URL) first.',
          409
        );
      }
      if (activeByEnvironment.has(installKey(userId, environmentId))) {
        throw new RuntimeLifecycleConflictError(
          `A runtime install is already running for environment "${environmentId}".`
        );
      }

      const run = beginRun(userId, environmentId);
      run.stream.publish({
        type: 'log',
        stream: 'system',
        line: `Setting up "${body.ssh.host}" to dial ${endpoint} (hub ${getVersion()}).`,
        done: false,
      });

      void (async () => {
        try {
          const outcome = await runPairedBootstrap({
            userId,
            environmentId,
            body,
            endpoint,
            runner: commandRunner(body.ssh),
            pairing,
            manager,
            stream: run.stream,
            signal: run.abort.signal,
          });
          if (run.abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          // `unsupervised` is a success: everything this hub can do over ssh
          // landed, and the console already named the one step left. Only a
          // machine that was supposed to dial in and did not is a failure.
          const failed = outcome === 'no-dial-in';
          finish(run, failed ? 'failed' : 'succeeded', failed ? 1 : 0);
        } catch (error) {
          if (run.abort.signal.aborted) {
            finish(run, 'cancelled', null);
            return;
          }
          run.stream.publish({
            type: 'log',
            stream: 'stderr',
            line: error instanceof Error ? error.message : String(error),
            done: false,
          });
          finish(run, 'failed', 1);
        }
      })();

      return { runId: run.runId };
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
      // Aborting alone, not finishing here too: the run's own async body — the
      // one place that knows whether cleanup (e.g. revoking a just-issued
      // pairing credential) is still in flight — is what calls `finish` once
      // it actually unwinds. Finishing eagerly freed `activeByEnvironment`
      // before that cleanup ran, so an immediate retry could mint a new
      // credential that the cancelled run's still-pending revoke then deleted.
      run.abort.abort();
      return Promise.resolve(true);
    },

    hasActiveInstall(userId, environmentId) {
      return activeByEnvironment.has(installKey(userId, environmentId));
    },
  };
}

export const runtimeLifecycleService = createRuntimeLifecycleService();

interface LiveUpdateInput {
  readonly userId: string;
  readonly environmentId: string;
  readonly transportKind: EnvironmentTransportKind;
  readonly health: RuntimeHealthReport;
  readonly manager: RuntimeConnectionManager;
  readonly loadRuntimeAsset: (
    platformId: string,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<LoadedRuntimeAsset>;
  readonly stream: EventBuffer;
  readonly signal: AbortSignal;
}

async function updateOverLiveConnection(input: LiveUpdateInput): Promise<void> {
  if (input.health.platform === 'win32') {
    throw new RuntimeLifecycleUnavailableError(
      'Live runtime update is currently available only for POSIX runtime slots.',
      409
    );
  }
  const version = getVersion();
  const platformId = input.health.platformId;
  if (!platformId) {
    throw new RuntimeLifecycleUnavailableError(
      'This runtime did not report an exact release platform identity. Upgrade it through its install path before using live updates.',
      409
    );
  }
  input.stream.publish({
    type: 'log',
    stream: 'system',
    line: `Loading the checksummed ${platformId} runtime for ${version}…`,
    done: false,
  });
  const asset = await input.loadRuntimeAsset(platformId, { signal: input.signal });
  if (asset.fromArchive) {
    throw new RuntimeAssetLoadError(
      `Release ${version} has no raw ${platformId} runtime binary. Live update never streams an archive as executable bytes.`
    );
  }
  const client = await input.manager.getClient(input.userId, input.environmentId);
  const progress = transferProgressPublisher(input.stream);
  let expectedDisconnect = false;
  let transferStarted = false;

  try {
    const result = await streamRuntimeUpdate({
      client: client.update,
      version,
      digest: asset.digest,
      bytes: asset.bytes,
      signal: input.signal,
      onProgress: progress,
      onSessionOpen: () => {
        transferStarted = true;
      },
      beforeCommit: () => {
        expectedDisconnect = true;
        input.manager.expectUpdateDisconnect(input.userId, input.environmentId);
      },
    });

    if (result.restart === 'manual') {
      input.manager.clearExpectedUpdateDisconnect(input.userId, input.environmentId);
      input.stream.publish({
        type: 'log',
        stream: 'system',
        line: `Runtime ${version} is installed. Restart this manually launched runtime to use it.`,
        done: false,
      });
      return;
    }

    input.stream.publish({
      type: 'log',
      stream: 'system',
      line: `Runtime ${version} is installed; waiting for the supervised restart…`,
      done: false,
    });
    await waitForRuntimeDisconnect(input.manager, input.userId, input.environmentId, input.signal);
    if (input.transportKind === 'websocket') {
      await waitForRuntimeVersion(
        input.manager,
        input.userId,
        input.environmentId,
        version,
        input.signal
      );
    } else {
      await input.manager.connect(input.userId, input.environmentId, { force: true });
    }
    await input.manager.refreshManifest(input.userId, input.environmentId);
    const status = input.manager.getStatus(input.userId, input.environmentId);
    if (status.state !== 'connected' || status.runtimeVersion !== version) {
      throw new Error(
        `Runtime restart did not report version ${version}; it reported ${status.runtimeVersion ?? status.state}.`
      );
    }
    input.stream.publish({
      type: 'log',
      stream: 'system',
      line: `Runtime reconnected on ${version}; version drift cleared.`,
      done: false,
    });
  } catch (error) {
    // Only these two codes prove the peer both answered and kept no session:
    // every `RUNTIME_UPDATE_REFUSED` path either never staged or discarded on
    // its way out, and `RUNTIME_DENIED` refuses before the first byte. A
    // cancel, a timeout or a dead transport all come back typed too, and none
    // of them says what the far side did with the transfer.
    const refused =
      error instanceof RuntimeRemoteError &&
      (error.code === 'RUNTIME_UPDATE_REFUSED' || error.code === 'RUNTIME_DENIED');
    if (expectedDisconnect && refused) {
      // The commit demonstrably did not land, so no handoff is coming and a
      // stale expectation would swallow the next real crash's backoff.
      input.manager.clearExpectedUpdateDisconnect(input.userId, input.environmentId);
    }
    if (transferStarted && !refused && !expectedDisconnect) {
      // There is deliberately no fourth protocol method. Dropping the
      // connection makes RuntimeHost.close discard the staged file, so a
      // transfer that died mid-stream does not leave a session refusing every
      // ordinary call until it expires. Dial-in runtimes redial on their own.
      input.manager.disconnectIfCurrent(input.userId, input.environmentId, client);
    }
    throw error;
  }
}

async function waitForRuntimeDisconnect(
  manager: RuntimeConnectionManager,
  userId: string,
  environmentId: string,
  signal: AbortSignal,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (manager.getStatus(userId, environmentId).state === 'connected') {
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new Error('Runtime published the update but did not exit for its supervised restart.');
    }
    await Bun.sleep(100);
  }
}

async function waitForRuntimeVersion(
  manager: RuntimeConnectionManager,
  userId: string,
  environmentId: string,
  version: string,
  signal: AbortSignal,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const status = manager.getStatus(userId, environmentId);
    if (status.state === 'connected' && status.runtimeVersion === version) return;
    await Bun.sleep(200);
  }
  throw new Error(`Runtime did not reconnect on version ${version} after its update.`);
}

async function pushOverSsh(
  configUnknown: unknown,
  stream: EventBuffer,
  signal: AbortSignal,
  options: { readonly force?: boolean } = {}
): Promise<void> {
  const config = environmentConfigFor('ssh', configUnknown);
  const runner = createSshCommandRunner(config);
  await pushRuntimeOverSsh(runner, config.host, stream, signal, options);
}

/**
 * The push logic on its own, taking a {@link RuntimeCommandRunner} rather than
 * building one — lets tests exercise the version short-circuit and the
 * probe/load/push sequence with a fake runner instead of a real ssh spawn.
 */
export async function pushRuntimeOverSsh(
  runner: RuntimeCommandRunner,
  host: string,
  stream: EventBuffer,
  signal: AbortSignal,
  options: { readonly force?: boolean } = {}
): Promise<void> {
  const version = getVersion();

  // A published release's bytes never change, so a remote already reporting
  // this exact version needs nothing pushed — the same "version equality
  // settles it for a release" fast path the WSL provisioner uses, without
  // paying for a platform probe or a download first. Reinstall forces a
  // replace even when the version already matches.
  if (!options.force && !isDevelopmentVersion(version)) {
    const current = await runner(runtimeVersionScript('remote'), {
      timeoutMs: 15_000,
      signal,
    }).catch(() => null);
    if (current && current.exitCode === 0 && current.stdout.trim() === version) {
      stream.publish({
        type: 'log',
        stream: 'system',
        line: `Runtime on "${host}" already reports version ${version}; nothing to push.`,
        done: false,
      });
      return;
    }
  }

  if (signal.aborted) return;

  const probe = await runner(PLATFORM_PROBE_SCRIPT, { timeoutMs: 30_000, signal });
  if (signal.aborted || probe.signal) return;
  if (probe.exitCode !== 0) {
    throw new RuntimePushError(
      `Could not probe "${host}": ${probe.stderr.trim() || probe.stdout.trim() || `exit ${probe.exitCode}`}`
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
      `Could not tell which runtime build "${host}" needs (${platformProbe.kernel} ${platformProbe.machine}).`
    );
  }

  stream.publish({
    type: 'log',
    stream: 'system',
    line: `Resolved platform ${platformId}; loading release asset…`,
    done: false,
  });
  if (signal.aborted) return;

  const asset = await loadRuntimeReleaseBytes(platformId, { signal });
  if (signal.aborted) return;
  const onProgress = transferProgressPublisher(stream);
  await pushRuntimeBinary({
    runner,
    slot: 'remote',
    version,
    bytes: asset.bytes,
    fromArchive: asset.fromArchive,
    timeoutMs: 600_000,
    signal,
    onStdinProgress: (written) => onProgress(written, asset.bytes.byteLength),
  });
}

/** Where a paired bootstrap got to. Every outcome leaves a usable machine. */
export type PairedBootstrapOutcome =
  /** The unit is installed and the runtime has dialed in. */
  | 'connected'
  /** Provisioned, consented and paired; nothing supervises it yet. */
  | 'unsupervised'
  /** The unit is installed, but nothing dialed this hub within the window. */
  | 'no-dial-in';

interface PairedBootstrapInput {
  readonly userId: string;
  readonly environmentId: string;
  readonly body: RuntimePairedBootstrapBody;
  /** `wss://…/api/runtime`, already resolved from the hub's public URL. */
  readonly endpoint: string;
  readonly runner: RuntimeCommandRunner;
  readonly pairing: RuntimePairingService;
  readonly manager: RuntimeConnectionManager;
  readonly stream: EventBuffer;
  readonly signal: AbortSignal;
  /**
   * How long to wait for the supervised runtime to appear on the hub's socket.
   * A seam: the default is the only value production uses, and a test that had
   * to sit out a real minute to cover the timeout would not be written.
   */
  readonly dialInTimeoutMs?: number;
}

const DIAL_IN_TIMEOUT_MS = 60_000;

/**
 * Turns an ssh-reachable machine into one that dials this hub by itself.
 *
 * Four things happen in order, and each is a call an earlier plan already
 * ships: the runtime is pushed into the managed slot, consent is recorded with
 * `setup`, a pairing credential is minted and handed to `connect` on stdin, and
 * a user-level service is installed to keep `connect` running. Only the last
 * two commands are new; the first two are the same helpers the environment card
 * calls.
 *
 * The credential never leaves the hub as a response: it is issued here and
 * piped straight into the ssh channel, so no browser ever holds a machine
 * credential it has no use for.
 *
 * A failed `service install` is not a failed onboarding. The machine is
 * provisioned, consented and holds a working credential at that point — what is
 * missing is a supervisor, which usually needs a decision at the machine (root
 * for linger, or a login session for the bus). That returns `unsupervised` with
 * the runtime's own refusal and the one command that finishes it, rather than
 * discarding four successful steps.
 *
 * Taking a {@link RuntimeCommandRunner} rather than building one keeps the
 * whole sequence exercisable with a fake runner, ssh never spawned.
 */
export async function runPairedBootstrap(
  input: PairedBootstrapInput
): Promise<PairedBootstrapOutcome> {
  const { body, runner, stream, signal } = input;
  const say = (line: string, channel: 'system' | 'stderr' = 'system'): void => {
    stream.publish({ type: 'log', stream: channel, line, done: false });
  };

  await pushRuntimeOverSsh(runner, body.ssh.host, stream, signal);
  signal.throwIfAborted();

  say(`Recording consent on "${body.ssh.host}" (${body.consent.profile}).`);
  const setup = buildSetupCommand(
    body.consent,
    resolveSetupAllow(body.consent),
    DEFAULT_SSH_RUNTIME_PATH
  );
  const setupResult = await runner(setup.script, {
    args: setup.args,
    timeoutMs: 60_000,
    signal,
  });
  signal.throwIfAborted();
  if (setupResult.exitCode !== 0) {
    throw new Error(sshStepFailure('Recording consent', body.ssh, setupResult));
  }

  // Issued only now: an earlier mint would be a live credential for a machine
  // that had not yet agreed to anything.
  const issued = await input.pairing.issue(input.userId, input.environmentId);
  try {
    say('Storing the pairing credential on that machine.');
    const bootstrap = buildConnectBootstrapCommand(DEFAULT_SSH_RUNTIME_PATH, input.endpoint);
    const bootstrapResult = await runner(bootstrap.script, {
      args: bootstrap.args,
      stdin: new TextEncoder().encode(issued.token),
      timeoutMs: 120_000,
      signal,
    });
    signal.throwIfAborted();
    if (bootstrapResult.exitCode !== 0) {
      throw new Error(sshStepFailure('Pairing', body.ssh, bootstrapResult));
    }

    say('Installing the service that keeps it connected.');
    const service = buildServiceInstallCommand(DEFAULT_SSH_RUNTIME_PATH);
    const serviceResult = await runner(service.script, {
      args: service.args,
      timeoutMs: 120_000,
      signal,
    });
    signal.throwIfAborted();
    if (serviceResult.exitCode !== 0) {
      // The runtime's refusals are typed and carry their own fix; pass them
      // through verbatim rather than restating them less accurately.
      say(serviceResult.stderr.trim() || serviceResult.stdout.trim(), 'stderr');
      say(
        `"${body.ssh.host}" is provisioned, consented and paired, but nothing keeps it running yet. Fix the above and run "${DEFAULT_SSH_RUNTIME_PATH} service install --mode connect" there, or start it once with "${DEFAULT_SSH_RUNTIME_PATH} connect" — the hub URL and credential are already stored.`
      );
      return 'unsupervised';
    }
    // A zero exit only means the unit was enabled and started. Enabling linger
    // is best-effort inside it — it needs root, so `attemptEnableLinger` warns
    // on stderr and keeps going rather than failing the install — which means a
    // "successful" install here can still not survive logout. Surface that
    // warning instead of discarding it now that the exit code passed the check
    // above; the paired end state's persistence promise depends on it.
    const serviceWarnings = serviceResult.stderr.trim();
    if (serviceWarnings) {
      say(serviceWarnings, 'stderr');
    }
  } catch (error) {
    // The token minted above never made it into a working, supervised setup —
    // pairing failed, or the run was cancelled mid-transfer. Either way it is
    // a live credential nothing legitimate holds; kill it rather than leaving
    // it to sit unused and unexpiring. A cancelled service install still
    // returns `unsupervised` above and keeps its credential on purpose.
    await input.pairing.revoke(input.userId, input.environmentId).catch(() => undefined);
    throw error;
  }

  say('Waiting for the runtime to dial in…');
  const connected = await waitForRuntimeDialIn(
    input.manager,
    input.userId,
    input.environmentId,
    signal,
    input.dialInTimeoutMs ?? DIAL_IN_TIMEOUT_MS
  );
  if (!connected) {
    say(
      // `service status` is the runtime's own command and answers on both
      // supported targets; `journalctl` does not exist on macOS, and this is
      // the only diagnostic a `no-dial-in` run prints, so naming a Linux-only
      // one would leave half the supported targets with nothing to run.
      `The service is installed on "${body.ssh.host}", but nothing has dialed ${input.endpoint} yet. Check that the machine can reach that address, then ask the service what it is doing with "${DEFAULT_SSH_RUNTIME_PATH} service status". Its log is in "journalctl --user -u mangostudio-runtime" on Linux, or "log show --predicate 'process == \\"mangostudio-runtime\\"' --last 1h" on macOS.`,
      'stderr'
    );
    return 'no-dial-in';
  }
  say(`"${body.ssh.host}" is connected.`);
  return 'connected';
}

/**
 * One sentence for a bootstrap step that exited non-zero, using 013's
 * classifier so an auth refusal, an unverified host key and a missing binary
 * each say what to do instead of sharing one "the command failed".
 */
function sshStepFailure(
  step: string,
  config: SshEnvironmentConfig,
  result: RuntimeCommandResult
): string {
  const stderr = result.stderr.trim();
  const reason = classifySshFailure({ stderr, exitCode: result.exitCode });
  const described = describeSshFailure(reason, config, stderr || result.stdout.trim());
  return `${step} failed: ${described}`;
}

async function waitForRuntimeDialIn(
  manager: RuntimeConnectionManager,
  userId: string,
  environmentId: string,
  signal: AbortSignal,
  timeoutMs = DIAL_IN_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (manager.getStatus(userId, environmentId).state === 'connected') return true;
    await Bun.sleep(500);
  }
  return false;
}

/**
 * Turns byte counts into install-console log lines, throttled to every 5%.
 *
 * Shared by both push transports on purpose: a ~95 MB transfer that reports
 * nothing is indistinguishable from a hang, and WSL — where the bytes cross a
 * 9P share into a cold distribution — is the slower of the two, not the one
 * that can afford to be a spinner.
 */
function transferProgressPublisher(stream: {
  publish(event: InstallStreamEvent): void;
}): (written: number, total: number) => void {
  let lastPct = -1;
  return (written, total) => {
    if (total <= 0) return;
    const pct = Math.min(100, Math.floor((written / total) * 100));
    if (pct === lastPct || pct % 5 !== 0) return;
    lastPct = pct;
    stream.publish({
      type: 'log',
      stream: 'stdout',
      line: `Transferred ${pct}% (${written}/${total} bytes)`,
      done: false,
    });
  };
}

function resolveSetupAllow(body: RuntimeSetupBody): RuntimeCapabilityAllow {
  if (body.profile !== 'custom') {
    return RUNTIME_CONSENT_PRESETS[body.profile];
  }
  return body.allow;
}

/**
 * The `setup` invocation to run over ssh for a consent submission. Exported
 * as a pure function so its shape is testable without spawning ssh.
 *
 * `binaryPath` is the environment's own resolved runtime path
 * ({@link sshRuntimePath}), not the managed slot: an environment pointed at a
 * custom `remoteRuntimePath` gets no push actions, so `setup` is the only thing
 * its card offers — running the managed-slot binary there would invoke
 * something that need not exist. The slot whose consent is written stays
 * `remote` either way; that is where the SSH transport reads it from.
 *
 * `custom` is not a `--profile` value the CLI accepts — `setup` requires a
 * base preset whenever `--yes` is set (`apps/runtime/src/setup.ts`), so
 * `custom` sends the narrowest preset (`none`) and lets `--allow` override
 * every key explicitly; the CLI derives the `custom` name itself from the
 * resulting non-preset allow set.
 */
export function buildSetupCommand(
  body: RuntimeSetupBody,
  allow: RuntimeCapabilityAllow,
  binaryPath: string = DEFAULT_SSH_RUNTIME_PATH
): { readonly script: string; readonly args: readonly string[] } {
  if (body.profile === 'custom') {
    return {
      script: `${RESOLVE_RUNTIME_PATH}exec "$p" setup --slot remote --profile none --allow "$2" --yes --json`,
      args: [
        binaryPath,
        RUNTIME_CAPABILITY_KEYS.map((key) => `${key}=${allow[key] ? 'true' : 'false'}`).join(','),
      ],
    };
  }

  return {
    script: `${RESOLVE_RUNTIME_PATH}exec "$p" setup --slot remote --profile "$2" --yes --json`,
    args: [binaryPath, body.profile],
  };
}

/** The hub's cache directory for one version — the one documented location. */
function runtimeCacheDir(version: string): string {
  return join(getHomeMangoDir(), 'runtime-cache', version);
}

/**
 * The runtime this hub would install for an environment, and whether a verified
 * copy is already staged.
 *
 * Only for transports the hub installs to. A dial-in machine gets copyable
 * commands instead: staging bytes on the hub would not move them any closer to
 * a machine the hub cannot reach.
 *
 * Prefers `platformId` over `platform`-`arch` because it is the exact release
 * identity, libc variant included — `linux-x64` and `linux-x64-musl` are
 * different assets, and only one of them exists on the release.
 *
 * The `platform`-`arch` fallback is refused outright for Linux: libc is not
 * derivable from either field, so a peer that predates `platformId` (or a
 * probe that could not resolve one) would silently guess the glibc asset for
 * what might be a musl machine and stage — or name as "the matching
 * runtime" — a binary that will not run there. darwin and win32 have no such
 * ambiguity, so they keep the fallback.
 */
function stagedRuntimeAssetFor(
  transportKind: EnvironmentTransportKind,
  health: RuntimeHealthReport | null,
  options: { readonly fromArchive?: boolean; readonly pinnedDigest?: string } = {}
): RuntimeStagedAsset | undefined {
  if (transportKind !== 'wsl' && transportKind !== 'ssh') return undefined;

  const platformHint =
    health?.platformId ??
    (health?.platform && health.platform !== 'linux' && health.arch
      ? `${health.platform}-${health.arch}`
      : undefined);

  return stagedRuntimeAsset({
    version: getVersion(),
    platformHint,
    cacheDir: runtimeCacheDir,
    present: false,
    fromArchive: options.fromArchive,
    pinnedDigest: options.pinnedDigest,
  });
}

/**
 * {@link stagedRuntimeAssetFor} plus the one question only the disk answers.
 *
 * Checks the raw asset first — what a download prefers — and falls back to the
 * platform archive: a release that publishes no raw runtime for this platform
 * caches the archive instead, and reporting the raw path would claim bytes
 * that were never written while the archive a download actually verified goes
 * unmentioned.
 */
async function resolveStagedRuntime(
  transportKind: EnvironmentTransportKind,
  health: RuntimeHealthReport | null
): Promise<RuntimeStagedAsset | undefined> {
  const raw = stagedRuntimeAssetFor(transportKind, health);
  if (!raw) return undefined;

  if (await pathExists(raw.path)) {
    return withPinnedVerify(transportKind, health, raw, {});
  }

  const archive = stagedRuntimeAssetFor(transportKind, health, { fromArchive: true });
  if (archive && (await pathExists(archive.path))) {
    return withPinnedVerify(transportKind, health, archive, { fromArchive: true });
  }

  return { ...raw, present: false };
}

/**
 * Rebuilds a staged asset's verify command from the digest recorded next to it
 * at download time, when one was recorded. A hub upgraded from before that
 * sidecar existed has cached files with none; the tag-based command it built
 * without a digest is what still runs for those.
 */
async function withPinnedVerify(
  transportKind: EnvironmentTransportKind,
  health: RuntimeHealthReport | null,
  base: RuntimeStagedAsset,
  options: { readonly fromArchive?: boolean }
): Promise<RuntimeStagedAsset> {
  const pinnedDigest = await readPinnedDigest(base.path);
  if (!pinnedDigest) return { ...base, present: true };
  const pinned = stagedRuntimeAssetFor(transportKind, health, { ...options, pinnedDigest });
  return { ...(pinned ?? base), present: true };
}

/** The digest recorded beside a cached asset, when one is recorded and readable. */
function readPinnedDigest(assetPath: string): Promise<string | undefined> {
  return readFile(runtimeDigestSidecarPath(assetPath), 'utf8').then(
    pinnedRuntimeDigest,
    () => undefined
  );
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function readSlotBytes(
  record: EnvironmentRecord,
  provisioner: WslProvisioner
): Promise<number | null> {
  if (record.transportKind === 'ssh') {
    const config = environmentConfigFor('ssh', record.config);
    const runner = createSshCommandRunner(config);
    const result = await runner(runtimeSlotBytesScript('remote'), { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return null;
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (record.transportKind === 'wsl') {
    return provisioner.slotBytes(environmentConfigFor('wsl', record.config).distro);
  }

  return null;
}
