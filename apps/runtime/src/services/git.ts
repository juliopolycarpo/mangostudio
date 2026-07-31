/**
 * Hardened Git spawn for the runtime protocol (`git.exec`).
 * Argv-array-only — never accepts a shell command string.
 */

import { RuntimeServiceError, RuntimeToolArgumentError } from '../errors';
import type { RuntimeGitExecParams, RuntimeGitExecResult } from '../methods';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const GIT_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'SYSTEMROOT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'PROGRAMDATA',
  // Commit signing resolves its key through the SSH agent or a relocated GnuPG
  // home; without these, `--gpg-sign` fails for correctly configured users.
  'SSH_AUTH_SOCK',
  'GNUPGHOME',
  'GPG_TTY',
] as const;

export class GitExecutionError extends RuntimeServiceError {
  constructor(
    message: string,
    data: {
      exitCode: number | null;
      stderr: string;
      stdout: string;
      args: readonly string[];
      aborted?: boolean;
    }
  ) {
    super('git_execution', message, data);
    this.name = 'GitExecutionError';
  }
}

interface CappedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

/** Builds the direct argv passed to Bun.spawn; no shell is involved. */
export function buildGitArgv(args: readonly string[]): string[] {
  return ['git', ...args];
}

/** Keeps only process state Git needs, then forces deterministic non-interactive behavior. */
export function buildGitEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of GIT_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

/**
 * Runs Git with bounded output and fails with structured, log-safe command context.
 * Wire params never include AbortSignal — pass it separately from the handler context.
 */
export async function execGit(
  params: RuntimeGitExecParams,
  signal?: AbortSignal
): Promise<RuntimeGitExecResult> {
  const { args, cwd, timeoutMs, acceptedExitCodes } = validateGitExecParams(params);

  let proc: ReturnType<typeof spawnGit>;
  try {
    proc = spawnGit(args, cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to start Git.';
    throw new GitExecutionError(detail, {
      exitCode: null,
      stderr: detail,
      stdout: '',
      args,
    });
  }

  let termination: 'timeout' | 'abort' | null = null;

  const kill = (reason: 'timeout' | 'abort') => {
    if (termination || proc.exitCode !== null) return;
    termination = reason;
    try {
      proc.kill('SIGKILL');
    } catch {
      // The child may have exited between the state check and kill.
    }
  };

  const timeoutId = setTimeout(() => kill('timeout'), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortHandler = () => kill('abort');
  signal?.addEventListener('abort', abortHandler, { once: true });
  if (signal?.aborted) abortHandler();

  try {
    const [stdout, stderr] = await Promise.all([
      readStreamCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readStreamCapped(proc.stderr, MAX_OUTPUT_BYTES),
    ]);
    const exitCode = await proc.exited;

    if (termination === 'abort') {
      throw new GitExecutionError('Git command aborted.', {
        exitCode,
        stderr: 'Git command aborted.',
        stdout: '',
        args,
        aborted: true,
      });
    }
    if (termination === 'timeout') {
      throw new GitExecutionError('Git command timed out.', {
        exitCode,
        stderr: 'Git command timed out.',
        stdout: '',
        args,
      });
    }
    if (stdout.truncated || stderr.truncated) {
      const message = `Git output exceeded ${MAX_OUTPUT_BYTES} bytes.`;
      throw new GitExecutionError(message, {
        exitCode,
        stderr: message,
        stdout: '',
        args,
      });
    }
    if (exitCode !== 0 && !acceptedExitCodes?.includes(exitCode)) {
      throw new GitExecutionError(
        stderr.text.trim() || stdout.text.trim() || 'Git command failed.',
        {
          exitCode,
          stderr: stderr.text.trim(),
          stdout: stdout.text.trim(),
          args,
        }
      );
    }

    return { stdout: stdout.text, stderr: stderr.text, exitCode };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortHandler);
  }
}

function validateGitExecParams(params: RuntimeGitExecParams): {
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  acceptedExitCodes?: readonly number[];
} {
  if (!Array.isArray(params.args) || params.args.some((arg) => typeof arg !== 'string')) {
    throw new RuntimeToolArgumentError('git.exec requires args to be an array of strings.');
  }
  if (params.args.some((arg) => arg.includes('\0'))) {
    throw new RuntimeToolArgumentError('git.exec args must not contain NUL bytes.');
  }
  if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
    throw new RuntimeToolArgumentError('git.exec requires a non-empty cwd string.');
  }
  // Both fields cross the wire untyped: a non-positive timeout fires the kill timer
  // immediately, and a non-array acceptedExitCodes throws a raw TypeError at the
  // exit-code check instead of a structured protocol error.
  if (
    params.timeoutMs !== undefined &&
    (typeof params.timeoutMs !== 'number' ||
      !Number.isFinite(params.timeoutMs) ||
      params.timeoutMs <= 0)
  ) {
    throw new RuntimeToolArgumentError('git.exec timeoutMs must be a positive finite number.');
  }
  if (
    params.acceptedExitCodes !== undefined &&
    (!Array.isArray(params.acceptedExitCodes) ||
      params.acceptedExitCodes.some((code) => !Number.isInteger(code)))
  ) {
    throw new RuntimeToolArgumentError('git.exec acceptedExitCodes must be an array of integers.');
  }
  // Reject a legacy/string command field if a caller smuggles it onto the object.
  if ('command' in params && (params as { command?: unknown }).command !== undefined) {
    throw new RuntimeToolArgumentError(
      'git.exec does not accept a command string; pass argv as args.'
    );
  }
  return {
    args: params.args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    acceptedExitCodes: params.acceptedExitCodes,
  };
}

function spawnGit(args: readonly string[], cwd: string) {
  return Bun.spawn(buildGitArgv(args), {
    cwd,
    env: buildGitEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<CappedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      chunks.push(value.subarray(0, remaining));
      capturedBytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}
