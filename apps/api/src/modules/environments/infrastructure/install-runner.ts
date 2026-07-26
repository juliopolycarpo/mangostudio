import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InstallRunStatus } from '@mangostudio/shared/environments';

const INSTALL_OUTPUT_LIMIT_BYTES = 1024 * 1024;

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

type InstallOutputStream = 'stdout' | 'stderr' | 'system';

export interface InstallLogLine {
  readonly stream: InstallOutputStream;
  readonly line: string;
}

interface RunInstallCommand {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly logPath: string;
}

interface RunInstallOptions {
  readonly signal?: AbortSignal;
  readonly onLog?: (event: InstallLogLine) => void;
  readonly outputLimitBytes?: number;
}

interface InstallRunnerResult {
  readonly exitCode: number | null;
  readonly status: Exclude<InstallRunStatus, 'running'>;
  readonly truncated: boolean;
  readonly finishedAt: number;
  readonly durationMs: number;
}

interface InstallSubprocess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal: 'SIGKILL'): void;
}

interface InstallRunnerDeps {
  readonly spawn: (argv: readonly string[], env: Record<string, string>) => InstallSubprocess;
  readonly now: () => number;
  readonly prepareLog: (path: string) => Promise<void>;
  readonly appendLog: (path: string, bytes: Uint8Array) => Promise<void>;
}

const defaultDeps: InstallRunnerDeps = {
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
};

export interface InstallRunner {
  run(command: RunInstallCommand, options?: RunInstallOptions): Promise<InstallRunnerResult>;
}

export function buildInstallEnvironment(
  source: NodeJS.ProcessEnv = process.env,
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

function emitLine(options: RunInstallOptions, stream: InstallOutputStream, line: string): void {
  options.onLog?.({ stream, line });
}

export function createInstallRunner(overrides: Partial<InstallRunnerDeps> = {}): InstallRunner {
  const deps = { ...defaultDeps, ...overrides };

  return {
    async run(command, options = {}) {
      const startedAt = deps.now();
      const outputLimit = options.outputLimitBytes ?? INSTALL_OUTPUT_LIMIT_BYTES;
      await deps.prepareLog(command.logPath);

      if (options.signal?.aborted) {
        const finishedAt = deps.now();
        return {
          exitCode: null,
          status: 'cancelled',
          truncated: false,
          finishedAt,
          durationMs: finishedAt - startedAt,
        };
      }

      let process: InstallSubprocess;
      try {
        process = deps.spawn(command.argv, buildInstallEnvironment(processEnv(), command.env));
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unable to start installer.';
        emitLine(options, 'system', detail);
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
        if (termination || process.exitCode !== null) return;
        termination = reason;
        try {
          process.kill('SIGKILL');
        } catch {
          // The child may exit between the state check and signal delivery.
        }
      };

      const timeoutId = setTimeout(() => kill('timed-out'), command.timeoutMs);
      const abortHandler = () => kill('cancelled');
      options.signal?.addEventListener('abort', abortHandler, { once: true });
      if (options.signal?.aborted) abortHandler();

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
          logWrites = logWrites.then(() => deps.appendLog(command.logPath, stableCopy));
        }
        return accepted;
      };

      const reportTruncation = () => {
        if (!truncated || truncationReported) return;
        truncationReported = true;
        emitLine(options, 'system', `Output truncated after ${outputLimit} bytes.`);
      };

      const readStream = async (
        stream: ReadableStream<Uint8Array>,
        streamName: Exclude<InstallOutputStream, 'system'>
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
              emitLine(options, streamName, line.endsWith('\r') ? line.slice(0, -1) : line);
            }
          }
          pending += decoder.decode();
          if (pending) emitLine(options, streamName, pending);
        } finally {
          reader.releaseLock();
        }
      };

      let exitCode: number | null = null;
      try {
        const results = await Promise.all([
          readStream(process.stdout, 'stdout'),
          readStream(process.stderr, 'stderr'),
          process.exited,
        ]);
        exitCode = results[2];
      } catch (error) {
        kill('cancelled');
        streamFailed = true;
        await process.exited.catch(() => undefined);
        const detail = error instanceof Error ? error.message : 'Installer output stream failed.';
        emitLine(options, 'system', detail);
      } finally {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', abortHandler);
      }

      // The queued log writes are drained on every path so a rejected append can
      // never surface as an unhandled rejection, and a log-file failure never
      // overrides the child's own terminal status.
      try {
        await logWrites;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown log write failure.';
        emitLine(options, 'system', `Install log write failed: ${detail}`);
      }

      const finishedAt = deps.now();
      const status: Exclude<InstallRunStatus, 'running'> = streamFailed
        ? 'failed'
        : (termination ?? (exitCode === 0 ? 'succeeded' : 'failed'));
      return {
        exitCode,
        status,
        truncated,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    },
  };
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export const installRunner = createInstallRunner();
