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
import { randomUUID } from 'node:crypto';
import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import type {
  ContainerDetection,
  ContainerEngine,
  ContainerEngineStatus,
  ContainerEnvironmentConfig,
  ContainerFailureReason,
} from '@mangostudio/shared/environments';
import {
  CONTAINER_NAME_PREFIX,
  containerEngineOf,
  containerEngineVersionCommand,
  containerImageInspectCommand,
  containerKillCommand,
  containerProbeCommand,
  containerPullCommand,
} from '@mangostudio/shared/environments';
import type { LinuxPlatformId } from '@mangostudio/shared/runtime-home';
import {
  PLATFORM_PROBE_SCRIPT,
  parsePlatformProbe,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';
import { createDiagnosticLogger } from '../../../lib/logger';
import { throwIfAborted } from '../domain/cancellation';
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
 * A pull's own progress text is far chattier than any other command here, so it
 * gets a cap of its own rather than sharing {@link MAX_OUTPUT_BYTES} and having
 * a normal pull mistaken for a hung one.
 */
const MAX_PULL_OUTPUT_BYTES = 4 * 1024 * 1024;
/** `execFile`'s error code when a command is killed for exceeding its buffer. */
const MAXBUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * How many image identities keep a probe. Small because it is one entry per
 * distinct image a hub has ever launched, and the answer is three lines of
 * `uname` — this exists to keep reconnects off the engine, not to be a store.
 */
const PROBE_CACHE_MAX_ENTRIES = 64;

/**
 * How long a detection answer is reused before the engines are asked again.
 *
 * Short on purpose: this exists to collapse a burst of identical questions, not
 * to remember what is installed.
 */
const DETECT_CACHE_TTL_MS = 5_000;

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
  /**
   * Whether `execFile`'s own timeout is what ended this call. Killing the CLI
   * this way does not stop a container it started on the daemon, so a caller
   * that named the container has to reap it itself.
   */
  readonly timedOut?: boolean;
}

export interface EngineRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  /**
   * Kills the CLI when the caller has stopped caring. Never passed to a
   * teardown command: those run precisely because something was cancelled, and
   * an already-aborted signal would stop the reaper before it spawned.
   */
  readonly signal?: AbortSignal;
}

export interface ContainerEngineDeps {
  readonly run: (
    command: string,
    args: readonly string[],
    options: EngineRunOptions
  ) => Promise<EngineResult>;
}

export interface PrepareImageOptions {
  /** Fires once, before a pull begins, and only when one is actually needed. */
  readonly onPullStart?: () => void;
  /**
   * Stops the preparation where it stands. A pull is the step this exists for:
   * it is bounded at {@link PULL_TIMEOUT_MS}, which is half an hour of a
   * download nobody may still be waiting for.
   */
  readonly signal?: AbortSignal;
}

export interface ContainerEngineService {
  detect(): Promise<ContainerDetection>;
  /**
   * Makes sure the image is on this machine and reports which runtime build it
   * needs.
   */
  prepare(
    config: ContainerEnvironmentConfig,
    options?: PrepareImageOptions
  ): Promise<LinuxPlatformId>;
  /** Best-effort teardown of a container this hub named. */
  kill(engine: ContainerEngine, name: string): Promise<void>;
}

function runWithExecFile(
  command: string,
  args: readonly string[],
  options: EngineRunOptions
): Promise<EngineResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
        signal: options.signal,
        ...HIDDEN_WINDOW,
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: unknown; killed?: boolean }) | null;
        const code = err?.code;
        resolve({
          stdout,
          stderr,
          // `execFile` reports a nonzero exit as a numeric `code` and a failure
          // to start the binary at all as a string one; only the latter is a
          // spawn error, and conflating them would report a missing image as a
          // missing engine.
          exitCode: typeof code === 'number' ? code : error ? null : 0,
          ...(typeof code === 'string' ? { spawnErrorCode: code } : {}),
          // `killed` is also set when `maxBuffer` cuts a command off; the
          // string `code` in that case already identifies it, so timeout is
          // only what is left once that case is excluded.
          ...(err?.killed && typeof code !== 'string' ? { timedOut: true } : {}),
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

  /**
   * The last detection answer, and the call currently producing one.
   *
   * Detection forks one CLI per engine and is asked by every client that opens
   * the add dialog — several browser tabs, or a refetch on focus, would
   * otherwise fork two processes each. The answer only changes when somebody
   * installs an engine or starts a daemon, so a short window is enough to make
   * this constant rather than linear in request count, while still reflecting
   * "I just started Docker" within a few seconds of it being true.
   */
  let detectCache: { readonly at: number; readonly value: ContainerDetection } | undefined;
  let detectInFlight: Promise<ContainerDetection> | undefined;

  const run = (
    command: { readonly command: string; readonly args: readonly string[] },
    options: EngineRunOptions
  ): Promise<EngineResult> => deps.run(command.command, command.args, options);

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

  const imageId = async (
    config: ContainerEnvironmentConfig,
    signal?: AbortSignal
  ): Promise<string | null> => {
    const engine = containerEngineOf(config);
    const result = await run(containerImageInspectCommand(config), {
      timeoutMs: INSPECT_TIMEOUT_MS,
      signal,
    });
    if (result.exitCode === 0) return result.stdout.trim() || null;

    // A killed CLI reports as an ordinary failure with no stderr, which would
    // be classified as an engine failure and painted on the card as one. Asked
    // before the classification so a cancelled inspect says so — the pull path
    // has the same rule.
    throwIfAborted(signal, 'Container preparation was cancelled.');
    // A missing image is the expected answer here, not a failure: it is what
    // says a pull is needed. Anything else — no engine, no daemon — is real.
    const error = refuse(result, { engine, image: config.image });
    if (error.reason === 'image-missing') return null;
    throw error;
  };

  const runDetect = async (): Promise<ContainerDetection> => {
    const engines = await Promise.all(
      ENGINES.map(async (engine): Promise<ContainerEngineStatus> => {
        const result = await run(containerEngineVersionCommand(engine), {
          timeoutMs: INSPECT_TIMEOUT_MS,
        });
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
  };

  return {
    async detect(): Promise<ContainerDetection> {
      const cached = detectCache;
      if (cached && Date.now() - cached.at < DETECT_CACHE_TTL_MS) return cached.value;
      // Callers that arrive while one is running share it rather than starting
      // a second: the question is the same and the answer is process-wide.
      detectInFlight ??= runDetect()
        .then((value) => {
          detectCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          detectInFlight = undefined;
        });
      return await detectInFlight;
    },

    async prepare(config, options = {}): Promise<LinuxPlatformId> {
      const engine = containerEngineOf(config);
      const context = { engine, image: config.image };
      const signal = options.signal;

      let id = await imageId(config, signal);
      if (!id) {
        // The one long step, and the only one nobody is asked to wait through:
        // the caller is told a pull started and stops holding its request open.
        options.onPullStart?.();
        logger.info('image_pull_started', { engine, image: config.image });
        const pull = await run(containerPullCommand(config), {
          timeoutMs: PULL_TIMEOUT_MS,
          maxOutputBytes: MAX_PULL_OUTPUT_BYTES,
          signal,
        });
        // A killed CLI reports as an ordinary non-zero exit with no stderr,
        // which would be classified as a registry failure and painted on a card
        // as one. Asked before the exit code so a cancellation says so.
        throwIfAborted(signal, 'Container preparation was cancelled.');
        if (pull.exitCode !== 0) {
          // A pull this chatty is not a spawn failure; classifying it as one
          // would report a rate limit or a slow registry as a missing engine.
          if (pull.spawnErrorCode === MAXBUFFER_ERROR_CODE) {
            throw new ContainerEngineError(
              'image-pull-failed',
              describeContainerFailure('image-pull-failed', { ...context, stderr: pull.stderr })
            );
          }
          throw refuse(pull, context);
        }
        id = await imageId(config, signal);
        if (!id) {
          throw new ContainerEngineError(
            'image-missing',
            `${engine} reported a successful pull of ${config.image} but still does not have it.`
          );
        }
      }

      const cacheKey = `${engine}|${id}`;
      const cached = probeCache.get(cacheKey);
      if (cached) {
        // Re-inserted, not just read: a Map orders by insertion, so the
        // eviction below only drops the image nobody has launched recently if
        // a hit moves the entry back to the young end.
        probeCache.delete(cacheKey);
        probeCache.set(cacheKey, cached);
        return cached;
      }

      // Left inline deliberately: the probe is three lines of `uname` against an
      // image that is already on disk, bounded at 60s, and cached per image
      // identity — so a connect that reaches here has nothing left worth
      // reporting a phase for.
      const probeName = `${CONTAINER_NAME_PREFIX}-probe-${randomUUID()}`;
      const probe = await run(containerProbeCommand(config, PLATFORM_PROBE_SCRIPT, probeName), {
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
      });
      if (probe.exitCode !== 0) {
        // `execFile`'s timeout only kills the CLI; the container it started
        // keeps running on the daemon until this backstop reaps it by name. A
        // cancel kills the same CLI the same way and leaves the same container,
        // so it is reaped on that path too — with no signal of its own, or the
        // reaper would be aborted before it spawned.
        if (probe.timedOut || signal?.aborted) {
          await run(containerKillCommand(engine, probeName), { timeoutMs: INSPECT_TIMEOUT_MS });
        }
        throwIfAborted(signal, 'Container preparation was cancelled.');
        throw refuse(probe, context);
      }

      const platformId = platformFromProbe(probe.stdout);
      if (!platformId) {
        throw new ContainerEngineError(
          'image-unsupported',
          `Could not tell which platform ${config.image} runs. It reported: ${probe.stdout.trim().replaceAll('\n', ' / ') || '(nothing)'}`
        );
      }

      // Oldest-first eviction: the map preserves insertion order and a hit
      // re-inserts above, so the entry this drops is the one least recently
      // launched.
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
      const result = await run(containerKillCommand(engine, name), {
        timeoutMs: INSPECT_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        logger.debug('kill_backstop_noop', { engine, name, stderr: result.stderr.trim() });
      }
    },
  };
}

/**
 * Turns a platform probe's output into a release platform id.
 *
 * Only Linux ids are usable: the container runs a Linux kernel whatever the
 * host is, and a probe that says anything else means the engine is in Windows
 * container mode, which this transport does not support.
 */
export function platformFromProbe(stdout: string): LinuxPlatformId | null {
  const probe = parsePlatformProbe(stdout);
  if (!probe.ok) return null;
  const resolved = resolveRuntimePlatformId(probe);
  return resolved?.startsWith('linux-') ? (resolved as LinuxPlatformId) : null;
}

export const containerEngineService = createContainerEngineService();
