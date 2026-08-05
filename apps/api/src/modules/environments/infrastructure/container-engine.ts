/**
 * Talks to `docker` / `podman` on the hub's own machine.
 *
 * Every call is a fresh spawn of the engine CLI with an argv array built in
 * shared — the hub never assembles a command string, so an image reference or a
 * mount path cannot become an option or a second command. Nothing here talks to
 * a socket directly: the CLI already knows where its daemon is, including the
 * rootless and Docker Desktop cases, and reimplementing that lookup would be a
 * second source of truth for "can this machine run containers".
 *
 * Linux containers only. A Windows or macOS hub is a supported host — Docker
 * Desktop runs a Linux VM — so nothing here is platform-gated the way WSL
 * detection is; what decides support is whether an engine answers.
 */

import { execFile } from 'node:child_process';
import type {
  ContainerDetection,
  ContainerEngine,
  ContainerEngineStatus,
  ContainerEnvironmentConfig,
  ContainerFailureReason,
} from '@mangostudio/shared/environments';
import {
  containerEngineOf,
  containerEngineVersionCommand,
  containerImageInspectCommand,
  containerKillCommand,
  containerProbeCommand,
  containerPullCommand,
} from '@mangostudio/shared/environments';
import type { LinuxPlatformId } from '@mangostudio/shared/runtime-home';
import { PLATFORM_PROBE_SCRIPT, resolveRuntimePlatformId } from '@mangostudio/shared/runtime-home';
import { createDiagnosticLogger } from '../../../lib/logger';
import { classifyContainerFailure, describeContainerFailure } from '../domain/container-failure';

/** Local metadata questions answer immediately or the engine is wedged. */
const INSPECT_TIMEOUT_MS = 15_000;
/** Starting a container from an image already on disk. */
const PROBE_TIMEOUT_MS = 60_000;
/**
 * A cold pull of a multi-gigabyte image over a slow link. Long because the
 * alternative is failing a download that would have succeeded; the card reports
 * the wait as its own phase rather than as a connection that has stalled.
 */
const PULL_TIMEOUT_MS = 1_800_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * How many image identities keep a probe. Small because it is one entry per
 * distinct image a hub has ever launched, and the answer is three lines of
 * `uname` — this exists to keep reconnects off the engine, not to be a store.
 */
const PROBE_CACHE_MAX_ENTRIES = 64;

const logger = createDiagnosticLogger('container-engine');

const ENGINES: readonly ContainerEngine[] = ['docker', 'podman'];

export class ContainerEngineError extends Error {
  readonly reason: ContainerFailureReason;

  constructor(reason: ContainerFailureReason, message: string) {
    super(message);
    this.name = 'ContainerEngineError';
    this.reason = reason;
  }
}

interface EngineResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly spawnErrorCode?: string;
}

export interface ContainerEngineDeps {
  readonly run: (
    command: string,
    args: readonly string[],
    timeoutMs: number
  ) => Promise<EngineResult>;
}

export interface ContainerEngineService {
  detect(): Promise<ContainerDetection>;
  /**
   * Makes sure the image is on this machine and reports which runtime build it
   * needs. `onPullStart` fires once, before a pull begins, and only when one is
   * actually needed.
   */
  prepare(
    config: ContainerEnvironmentConfig,
    hooks?: { readonly onPullStart?: () => void }
  ): Promise<LinuxPlatformId>;
  /** Best-effort teardown of a container this hub named. */
  kill(engine: ContainerEngine, name: string): Promise<void>;
}

function runWithExecFile(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<EngineResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as (Error & { code?: unknown }) | null)?.code;
        resolve({
          stdout,
          stderr,
          // `execFile` reports a nonzero exit as a numeric `code` and a failure
          // to start the binary at all as a string one; only the latter is a
          // spawn error, and conflating them would report a missing image as a
          // missing engine.
          exitCode: typeof code === 'number' ? code : error ? null : 0,
          ...(typeof code === 'string' ? { spawnErrorCode: code } : {}),
        });
      }
    );
  });
}

const defaultDeps: ContainerEngineDeps = { run: runWithExecFile };

export function createContainerEngineService(
  overrides: Partial<ContainerEngineDeps> = {}
): ContainerEngineService {
  const deps = { ...defaultDeps, ...overrides };
  /**
   * Probes keyed by the image's own identity, not by its name.
   *
   * A tag is a moving target: `node:22` re-pulled tomorrow can be a different
   * image, and on a machine with an emulator it can even be a different
   * architecture. Keying on the id `image inspect` just returned means a
   * re-pulled image misses the cache by construction, so there is no
   * invalidation rule to get wrong and no way for a stale answer to survive.
   */
  const probeCache = new Map<string, LinuxPlatformId>();

  const run = (
    command: { readonly command: string; readonly args: readonly string[] },
    timeoutMs: number
  ): Promise<EngineResult> => deps.run(command.command, command.args, timeoutMs);

  const refuse = (
    result: EngineResult,
    context: { readonly engine: ContainerEngine; readonly image: string }
  ): ContainerEngineError => {
    const reason = classifyContainerFailure({
      stderr: result.stderr,
      exitCode: result.exitCode,
      spawnErrorCode: result.spawnErrorCode,
    });
    return new ContainerEngineError(
      reason,
      describeContainerFailure(reason, { ...context, stderr: result.stderr })
    );
  };

  const imageId = async (config: ContainerEnvironmentConfig): Promise<string | null> => {
    const engine = containerEngineOf(config);
    const result = await run(containerImageInspectCommand(config), INSPECT_TIMEOUT_MS);
    if (result.exitCode === 0) return result.stdout.trim() || null;

    // A missing image is the expected answer here, not a failure: it is what
    // says a pull is needed. Anything else — no engine, no daemon — is real.
    const error = refuse(result, { engine, image: config.image });
    if (error.reason === 'image-missing') return null;
    throw error;
  };

  return {
    async detect(): Promise<ContainerDetection> {
      const engines = await Promise.all(
        ENGINES.map(async (engine): Promise<ContainerEngineStatus> => {
          const result = await run(containerEngineVersionCommand(engine), INSPECT_TIMEOUT_MS);
          if (result.exitCode === 0) {
            const version = result.stdout.trim();
            return { engine, available: true, ...(version ? { version } : {}) };
          }
          return {
            engine,
            available: false,
            reason: classifyContainerFailure({
              stderr: result.stderr,
              exitCode: result.exitCode,
              spawnErrorCode: result.spawnErrorCode,
            }),
          };
        })
      );
      return { available: engines.some((status) => status.available), engines };
    },

    async prepare(config, hooks = {}): Promise<LinuxPlatformId> {
      const engine = containerEngineOf(config);
      const context = { engine, image: config.image };

      let id = await imageId(config);
      if (!id) {
        // The one long step, and the only one a user is asked to wait through.
        hooks.onPullStart?.();
        logger.info('image_pull_started', { engine, image: config.image });
        const pull = await run(containerPullCommand(config), PULL_TIMEOUT_MS);
        if (pull.exitCode !== 0) throw refuse(pull, context);
        id = await imageId(config);
        if (!id) {
          throw new ContainerEngineError(
            'image-missing',
            `${engine} reported a successful pull of ${config.image} but still does not have it.`
          );
        }
      }

      const cacheKey = `${engine}|${id}`;
      const cached = probeCache.get(cacheKey);
      if (cached) return cached;

      const probe = await run(
        containerProbeCommand(config, PLATFORM_PROBE_SCRIPT),
        PROBE_TIMEOUT_MS
      );
      if (probe.exitCode !== 0) throw refuse(probe, context);

      const platformId = platformFromProbe(probe.stdout);
      if (!platformId) {
        throw new ContainerEngineError(
          'image-unsupported',
          `Could not tell which platform ${config.image} runs. It reported: ${probe.stdout.trim().replaceAll('\n', ' / ') || '(nothing)'}`
        );
      }

      // Oldest-first eviction: the map preserves insertion order, and the entry
      // a hub is actively using is re-read rather than re-inserted, so this
      // drops images nobody has launched recently.
      if (probeCache.size >= PROBE_CACHE_MAX_ENTRIES) {
        const oldest = probeCache.keys().next();
        if (!oldest.done) probeCache.delete(oldest.value);
      }
      probeCache.set(cacheKey, platformId);
      logger.info('image_probed', { engine, image: config.image, platformId });
      return platformId;
    },

    async kill(engine, name): Promise<void> {
      // The container is normally gone already: `--rm` plus the runtime exiting
      // on EOF is the ordinary teardown, and this only catches the case where
      // the client died without reaping it. So a failure here is the expected
      // outcome, not an error worth surfacing.
      const result = await run(containerKillCommand(engine, name), INSPECT_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        logger.debug('kill_backstop_noop', { engine, name, stderr: result.stderr.trim() });
      }
    },
  };
}

/**
 * Turns the probe's three lines into a release platform id.
 *
 * Only Linux ids are usable: the container runs a Linux kernel whatever the
 * host is, and a probe that says anything else means the engine is in Windows
 * container mode, which this transport does not support.
 */
export function platformFromProbe(stdout: string): LinuxPlatformId | null {
  const [kernel = '', machine = '', libc = ''] = stdout.trim().split(/\r?\n/);
  const resolved = resolveRuntimePlatformId({ kernel, machine, libc });
  return resolved?.startsWith('linux-') ? (resolved as LinuxPlatformId) : null;
}

export const containerEngineService = createContainerEngineService();
