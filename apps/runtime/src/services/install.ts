/**
 * Runs one install recipe on this machine.
 *
 * The hub decides everything about *whether*: which recipes exist, which are
 * allowed, which environment was trusted, and what the audit row says. What
 * lives here is the part that can only happen where the software is going —
 * spawning the argv, capturing bounded output, and killing it on time or on
 * request. Nothing is interpolated: the argv arrives already built.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RuntimeToolArgumentError } from '../errors';
import type { RuntimeEventInput } from '../host';
import type {
  RuntimeInstallCancelParams,
  RuntimeInstallOutputEvent,
  RuntimeInstallRunParams,
  RuntimeInstallRunResult,
} from '../methods';
import { RUNTIME_INSTALL_OUTPUT_TOPIC } from '../methods';

const INSTALL_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * The child's environment, filtered down to what an installer legitimately
 * needs. Inheriting the whole environment would hand a third-party script every
 * credential this process happens to be holding.
 */
const INSTALL_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'NVM_DIR',
  'BUN_INSTALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const RECIPE_ENV_KEYS = ['NVM_DIR', 'PROFILE'] as const;

interface InstallSubprocess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal: 'SIGKILL'): void;
}

interface InstallHostDeps {
  readonly spawn: (argv: readonly string[], env: Record<string, string>) => InstallSubprocess;
  readonly now: () => number;
  readonly prepareLog: (path: string) => Promise<void>;
  readonly appendLog: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly sourceEnv: () => Readonly<Record<string, string | undefined>>;
  /** Root used to resolve relative log paths from the hub. */
  readonly runtimeHome?: () => string;
}

function defaultRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MANGO_HOME?.trim();
  return join(override && override.length > 0 ? override : join(homedir(), '.mango'), 'runtime');
}

/**
 * Hub may send an absolute path (local installs) or a relative one for remotes
 * (e.g. `.mango/runtime/logs/…` or `logs/…`). Relative paths land under the
 * runtime home so a remote never writes beside whatever cwd the process had.
 */
function resolveInstallLogPath(
  logPath: string,
  runtimeHome: string = defaultRuntimeHome(),
  home: string = homedir()
): string {
  if (isAbsolute(logPath)) return logPath;
  if (logPath.startsWith('.mango/') || logPath.startsWith('.mango\\')) {
    return join(home, logPath);
  }
  return join(runtimeHome, logPath);
}

const DEFAULT_DEPS: InstallHostDeps = {
  spawn: (argv, env) =>
    Bun.spawn([...argv], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as InstallSubprocess,
  now: Date.now,
  prepareLog: async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, new Uint8Array());
  },
  appendLog: (path, bytes) => appendFile(path, bytes),
  sourceEnv: () => process.env,
  runtimeHome: () => defaultRuntimeHome(),
};

export function buildInstallEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  recipeEnv: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INSTALL_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of RECIPE_ENV_KEYS) {
    const value = recipeEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface InstallService {
  run(params: RuntimeInstallRunParams): Promise<RuntimeInstallRunResult>;
  cancel(params: RuntimeInstallCancelParams): Promise<{ readonly ok: true }>;
  /** Aborts everything still running. Used when the connection goes away. */
  close(): void;
}

export interface InstallServiceOptions {
  /** Publishes an `evt` frame; log lines stream through it as they arrive. */
  readonly emit: (event: RuntimeEventInput) => void;
  readonly deps?: Partial<InstallHostDeps>;
}

export function createInstallService(options: InstallServiceOptions): InstallService {
  const deps: InstallHostDeps = { ...DEFAULT_DEPS, ...options.deps };
  const active = new Map<string, () => void>();

  const publish = (runId: string, payload: RuntimeInstallOutputEvent, end?: true): void => {
    options.emit({
      topic: RUNTIME_INSTALL_OUTPUT_TOPIC,
      streamId: runId,
      payload,
      ...(end ? { end } : {}),
    });
  };

  return {
    async run(params) {
      if (params.argv.length === 0) {
        throw new RuntimeToolArgumentError('An install run needs a command to execute.');
      }
      if (active.has(params.runId)) {
        throw new RuntimeToolArgumentError(`Install run "${params.runId}" is already active.`);
      }

      const startedAt = deps.now();
      const logPath = resolveInstallLogPath(
        params.logPath,
        deps.runtimeHome?.() ?? defaultRuntimeHome()
      );
      const outputLimit = params.outputLimitBytes ?? INSTALL_OUTPUT_LIMIT_BYTES;
      const emitLine = (stream: RuntimeInstallOutputEvent['stream'], line: string) => {
        publish(params.runId, { stream, line });
      };
      const endStream = () => {
        publish(params.runId, { stream: 'system', line: '', end: true }, true);
      };

      // Reserved before any await so a concurrent cancel/start for the same id
      // cannot slip in while prepareLog is still opening the file.
      active.set(params.runId, () => undefined);

      try {
        await deps.prepareLog(logPath);
      } catch (error) {
        active.delete(params.runId);
        const detail = error instanceof Error ? error.message : 'Unable to prepare install log.';
        emitLine('system', detail);
        endStream();
        const finishedAt = deps.now();
        return {
          exitCode: null,
          status: 'spawn-failed',
          truncated: false,
          finishedAt,
          durationMs: finishedAt - startedAt,
        };
      }

      let child: InstallSubprocess;
      try {
        child = deps.spawn(params.argv, buildInstallEnvironment(deps.sourceEnv(), params.env));
      } catch (error) {
        active.delete(params.runId);
        const detail = error instanceof Error ? error.message : 'Unable to start installer.';
        emitLine('system', detail);
        endStream();
        const finishedAt = deps.now();
        return {
          exitCode: null,
          status: 'spawn-failed',
          truncated: false,
          finishedAt,
          durationMs: finishedAt - startedAt,
        };
      }

      let termination: 'cancelled' | 'timed-out' | null = null;
      let streamFailed = false;
      let capturedBytes = 0;
      let truncated = false;
      let truncationReported = false;
      let logWrites = Promise.resolve();

      const kill = (reason: 'cancelled' | 'timed-out') => {
        if (termination || child.exitCode !== null) return;
        termination = reason;
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may exit between the state check and signal delivery.
        }
      };

      const timeoutId = setTimeout(() => kill('timed-out'), params.timeoutMs);
      active.set(params.runId, () => kill('cancelled'));

      const capture = (bytes: Uint8Array): Uint8Array => {
        const remaining = outputLimit - capturedBytes;
        if (remaining <= 0) {
          truncated = true;
          return new Uint8Array();
        }
        const accepted = bytes.subarray(0, remaining);
        capturedBytes += accepted.byteLength;
        if (accepted.byteLength < bytes.byteLength) truncated = true;
        if (accepted.byteLength > 0) {
          const stableCopy = accepted.slice();
          logWrites = logWrites.then(() => deps.appendLog(logPath, stableCopy));
        }
        return accepted;
      };

      const reportTruncation = () => {
        if (!truncated || truncationReported) return;
        truncationReported = true;
        emitLine('system', `Output truncated after ${outputLimit} bytes.`);
      };

      const readStream = async (
        stream: ReadableStream<Uint8Array>,
        streamName: Exclude<RuntimeInstallOutputEvent['stream'], 'system'>
      ) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const accepted = capture(value);
            reportTruncation();
            if (accepted.byteLength === 0) continue;
            pending += decoder.decode(accepted, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
              emitLine(streamName, line.endsWith('\r') ? line.slice(0, -1) : line);
            }
          }
          pending += decoder.decode();
          if (pending) emitLine(streamName, pending);
        } finally {
          reader.releaseLock();
        }
      };

      let exitCode: number | null = null;
      try {
        const results = await Promise.all([
          readStream(child.stdout, 'stdout'),
          readStream(child.stderr, 'stderr'),
          child.exited,
        ]);
        exitCode = results[2];
      } catch (error) {
        kill('cancelled');
        streamFailed = true;
        await child.exited.catch(() => undefined);
        const detail = error instanceof Error ? error.message : 'Installer output stream failed.';
        emitLine('system', detail);
      } finally {
        clearTimeout(timeoutId);
        active.delete(params.runId);
      }

      // The queued log writes are drained on every path so a rejected append can
      // never surface as an unhandled rejection, and a log-file failure never
      // overrides the child's own terminal status.
      try {
        await logWrites;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown log write failure.';
        emitLine('system', `Install log write failed: ${detail}`);
      }

      const finishedAt = deps.now();
      const status = streamFailed
        ? ('failed' as const)
        : (termination ?? (exitCode === 0 ? ('succeeded' as const) : ('failed' as const)));
      // Ends the stream so the hub stops waiting on frames that cannot arrive,
      // even though the terminal status also travels on the response.
      endStream();
      return {
        exitCode,
        status,
        truncated,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    },

    cancel(params) {
      // A run that already finished is not an error to cancel: the hub may be
      // acting on a view of the world one frame behind this one.
      active.get(params.runId)?.();
      return Promise.resolve({ ok: true as const });
    },

    close() {
      for (const abort of [...active.values()]) abort();
      active.clear();
    },
  };
}
