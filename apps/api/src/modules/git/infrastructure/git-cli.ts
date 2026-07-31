import {
  RuntimeRemoteError,
  buildGitArgv as runtimeBuildGitArgv,
  buildGitEnvironment as runtimeBuildGitEnvironment,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getRuntimeClient } from '../../../services/runtime-client';

export interface GitRuntimeSelection {
  readonly userId: string;
  readonly environmentId: string;
}

export interface RunGitOptions {
  readonly cwd: string;
  readonly userId?: string;
  readonly environmentId?: string;
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

const availabilityProbes = new Map<string, Promise<boolean>>();

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
    const runtime = await getRuntimeClient(options.userId, options.environmentId);
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

/**
 * Probes Git once per process. A positive result is cached for the lifetime of the
 * server; a negative one is not, because it can mean "the runtime handshake was
 * down" rather than "Git is missing", and pinning that would report Git as
 * unavailable until restart. `getRuntimeClient` drops cached rejections for the
 * same reason.
 */
export function isGitAvailable(
  selection: GitRuntimeSelection = {
    userId: 'local',
    environmentId: LOCAL_ENVIRONMENT_ID,
  }
): Promise<boolean> {
  const key = `${selection.userId}:${selection.environmentId}`;
  const current = availabilityProbes.get(key);
  if (current) return current;

  const probe = probeGitAvailability(selection).then((available) => {
    if (!available) availabilityProbes.delete(key);
    return available;
  });
  availabilityProbes.set(key, probe);
  return probe;
}

async function probeGitAvailability(selection: GitRuntimeSelection): Promise<boolean> {
  try {
    const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
    return runtime.manifest.git.available;
  } catch {
    // Fall through to a second attempt when the handshake itself failed; the
    // connection manager drops the cached rejection, so this can reconnect.
  }
  try {
    await runGit(['--version'], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      ...selection,
    });
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
