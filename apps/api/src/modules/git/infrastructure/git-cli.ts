import {
  RuntimeRemoteError,
  buildGitArgv as runtimeBuildGitArgv,
  buildGitEnvironment as runtimeBuildGitEnvironment,
} from '@mangostudio/runtime';
import { getRuntimeClient } from '../../../services/runtime-client';

export interface RunGitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly acceptedExitCodes?: readonly number[];
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitCliError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly args: readonly string[];
  /** True when the caller cancelled the request rather than Git failing. */
  readonly aborted: boolean;

  constructor(
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
    aborted = false,
    stdout = ''
  ) {
    const detail = stderr.trim() || stdout.trim() || 'Git command failed.';
    super(detail);
    this.name = 'GitCliError';
    this.exitCode = exitCode;
    this.stderr = stderr.trim();
    this.stdout = stdout.trim();
    this.args = [...args];
    this.aborted = aborted;
  }
}

let availabilityProbe: Promise<boolean> | null = null;

/** Builds the direct argv passed to Bun.spawn; no shell is involved. */
export function buildGitArgv(args: readonly string[]): string[] {
  return runtimeBuildGitArgv(args);
}

/** Keeps only process state Git needs, then forces deterministic non-interactive behavior. */
export function buildGitEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return runtimeBuildGitEnvironment(source);
}

/** Runs Git via the runtime `git.exec` method and maps failures to GitCliError. */
export async function runGit(
  args: readonly string[],
  options: RunGitOptions
): Promise<GitCommandResult> {
  try {
    const runtime = await getRuntimeClient();
    return await runtime.git.exec(
      {
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        acceptedExitCodes: options.acceptedExitCodes,
      },
      { signal: options.signal }
    );
  } catch (error) {
    throw mapGitFailure(args, error);
  }
}

/** Probes Git once per process; availability is stable for the lifetime of the server. */
export function isGitAvailable(): Promise<boolean> {
  availabilityProbe ??= probeGitAvailability();
  return availabilityProbe;
}

async function probeGitAvailability(): Promise<boolean> {
  try {
    const runtime = await getRuntimeClient();
    return runtime.manifest.git.available;
  } catch {
    // Fall through to a direct exec probe when the runtime handshake is unavailable.
  }
  try {
    await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function mapGitFailure(args: readonly string[], error: unknown): GitCliError {
  if (isAbortError(error)) {
    return new GitCliError(args, null, 'Git command aborted.', true);
  }
  if (error instanceof RuntimeRemoteError && detailString(error, 'kind') === 'git_execution') {
    return new GitCliError(
      detailStringArray(error, 'args') ?? args,
      detailExitCode(error),
      detailString(error, 'stderr') ?? error.message,
      detailBoolean(error, 'aborted'),
      detailString(error, 'stdout') ?? ''
    );
  }
  if (error instanceof Error) {
    return new GitCliError(args, null, error.message);
  }
  return new GitCliError(args, null, 'Git command failed.');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function detailString(error: RuntimeRemoteError, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function detailBoolean(error: RuntimeRemoteError, key: string): boolean {
  return error.details?.[key] === true;
}

function detailExitCode(error: RuntimeRemoteError): number | null {
  const value = error.details?.exitCode;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function detailStringArray(error: RuntimeRemoteError, key: string): string[] | undefined {
  const value = error.details?.[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value;
}
