import {
  type RuntimeGitExecResult,
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

/**
 * Runs Git via the runtime `git.exec` method and maps failures to GitCliError.
 *
 * Every Git call that reads repository state goes through here — status, diff,
 * log, branch and ref listings — and every one of them treats the output as
 * authoritative rather than as an advisory log line. (`lib/build-info.ts` runs
 * git directly, but that is synchronous local git for build metadata, with no
 * runtime pipe to be held open.) So a capture the runtime flagged
 * `incomplete` — a surviving helper still held a pipe when it stopped reading —
 * is rejected here rather than returned: a short `status --porcelain` reading
 * as a clean tree, or a short `diff` reading as no changes, is a wrong answer
 * wearing the shape of an ordinary one.
 */
export async function runGit(
  args: readonly string[],
  options: RunGitOptions
): Promise<GitCommandResult> {
  let result: RuntimeGitExecResult;
  try {
    const runtime = await getRuntimeClient(options.userId, options.environmentId);
    result = await runtime.git.exec(
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
  if (result.incomplete) {
    throw new GitCliError(
      args,
      result.exitCode,
      'Git exited, but a surviving helper process still held its output pipe; the capture is incomplete.',
      false,
      result.stdout
    );
  }
  return result;
}

/**
 * Reads Git availability from the connected runtime's manifest on every call
 * rather than memoizing it. A memo keyed by environment outlives the connection
 * it described: disconnects, config changes, and a deleted id recreated against
 * a different target would all keep answering for the old runtime. The
 * connection manager already caches the connection and its manifest, so a
 * connected environment costs a map lookup here.
 *
 * A runtime the hub cannot reach has no Git the hub can run, so an unreachable
 * environment is reported unavailable rather than probed a second time: any
 * such probe would have to travel through the same connection that just failed.
 */
export async function isGitAvailable(
  selection: GitRuntimeSelection = {
    userId: 'local',
    environmentId: LOCAL_ENVIRONMENT_ID,
  }
): Promise<boolean> {
  try {
    const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
    return runtime.manifest.git.available;
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
