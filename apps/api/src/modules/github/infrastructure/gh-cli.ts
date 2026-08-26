/**
 * Hub-side facade over the runtime's `gh.exec` / `gh.mutate` methods.
 *
 * `gh` used to be spawned here, in the hub process, against the hub's
 * filesystem and the hub's `~/.config/gh`. That is wrong for every chat pinned
 * to a WSL, SSH, or container environment: the workdir this facade was handed
 * is a path on *that* machine, and the account `gh` would have answered as is
 * the one on *this* one. It cannot work, and it fails in the shape of a repo
 * that has no GitHub remote rather than in the shape of a misconfiguration. So
 * the spawn moved to the runtime, exactly where `git` already runs, and this
 * file became the transport call and the error translation around it.
 */

import {
  type RuntimeGhExecResult,
  RuntimeRemoteError,
  buildGhArgv as runtimeBuildGhArgv,
  buildGhEnvironment as runtimeBuildGhEnvironment,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getRuntimeClient } from '../../../services/runtime-client';
import {
  detailBoolean,
  detailExitCode,
  detailString,
  detailStringArray,
  isAbortError,
} from '../../../services/runtime-client/remote-error-details';
import { createEnvironmentProbeCache, type ProbeEnvironmentKey } from './environment-probe-cache';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 60_000;

const GH_REPO_FIELDS = 'nameWithOwner,defaultBranchRef,url';
const GH_PR_FIELDS = 'number,title,state,isDraft,url,headRefName,baseRefName';

/** Which machine a `gh` call runs on. Defaults to this user's local runtime. */
export type GhRuntimeSelection = ProbeEnvironmentKey;

export const LOCAL_GH_SELECTION: GhRuntimeSelection = {
  userId: 'local',
  environmentId: LOCAL_ENVIRONMENT_ID,
};

export interface RunGhOptions {
  readonly cwd: string;
  readonly userId?: string;
  readonly environmentId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Sends the call to `gh.mutate` instead of `gh.exec`.
   *
   * Not a hint: the two methods answer to different consent, so this is the
   * hub declaring which half of `gh` it is asking for. Getting it wrong cannot
   * widen anything — the runtime keeps a separate subcommand allowlist per
   * method and refuses a mismatch — it only fails the call.
   */
  readonly mutation?: boolean;
}

export interface GhCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GhCliError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly args: readonly string[];
  /** True when the caller cancelled the request rather than gh failing. */
  readonly aborted: boolean;

  constructor(
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
    aborted = false,
    stdout = ''
  ) {
    const detail = stderr.trim() || stdout.trim() || 'GitHub CLI command failed.';
    super(detail);
    this.name = 'GhCliError';
    this.exitCode = exitCode;
    this.stderr = stderr.trim();
    this.stdout = stdout.trim();
    this.args = [...args];
    this.aborted = aborted;
  }
}

export interface GithubCli {
  readonly isAvailable: (selection: GhRuntimeSelection) => Promise<boolean>;
  readonly isAuthenticated: (selection: GhRuntimeSelection) => Promise<boolean>;
  readonly viewRepo: (
    cwd: string,
    selection: GhRuntimeSelection,
    signal?: AbortSignal
  ) => Promise<GhCommandResult>;
  readonly viewCurrentPr: (
    cwd: string,
    selection: GhRuntimeSelection,
    signal?: AbortSignal
  ) => Promise<GhCommandResult>;
}

export type GhCommandRunner = (
  args: readonly string[],
  options: RunGhOptions
) => Promise<GhCommandResult>;

export interface CreateGhCliOptions {
  readonly now?: () => number;
  readonly probeCacheTtlMs?: number;
  readonly runner?: GhCommandRunner;
  readonly available?: (selection: GhRuntimeSelection) => Promise<boolean>;
  /** Resolves the cwd an environment-wide probe runs in. */
  readonly probeCwd?: (selection: GhRuntimeSelection) => Promise<string>;
}

/** Builds the direct argv passed to Bun.spawn on the runtime; no shell is involved. */
export function buildGhArgv(args: readonly string[]): string[] {
  return runtimeBuildGhArgv(args);
}

/** Keeps gh configuration and network settings without forwarding token variables. */
export function buildGhEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return runtimeBuildGhEnvironment(source);
}

/**
 * Runs one `gh` command on the selected environment's runtime.
 *
 * @example
 * await runGh(['pr', 'view', '--json', 'number'], { cwd, environmentId, userId });
 */
export async function runGh(
  args: readonly string[],
  options: RunGhOptions
): Promise<GhCommandResult> {
  let result: RuntimeGhExecResult;
  try {
    const runtime = await getRuntimeClient(options.userId, options.environmentId);
    const call = options.mutation ? runtime.gh.mutate : runtime.gh.exec;
    result = await call(
      { args, cwd: options.cwd, timeoutMs: options.timeoutMs },
      { signal: options.signal }
    );
  } catch (error) {
    throw mapGhFailure(args, error);
  }
  // Every caller parses this output as JSON and believes the answer. A capture
  // the runtime flagged `incomplete` — a surviving child still held a pipe when
  // it stopped reading — would parse into a repo with no pull request, or fail
  // to parse at all and be reported as gh emitting invalid JSON. Both are wrong
  // answers wearing the shape of ordinary ones, so it is rejected here.
  if (result.incomplete) {
    throw new GhCliError(
      args,
      result.exitCode,
      'GitHub CLI exited, but a surviving child process still held its output pipe; the capture is incomplete.',
      false,
      result.stdout
    );
  }
  return result;
}

/**
 * Reads GitHub CLI availability from the connected runtime's manifest rather
 * than probing, and never memoizes the answer.
 *
 * A memo keyed by environment outlives the connection it described: disconnects,
 * config changes, and a deleted id recreated against a different target would
 * all keep answering for the old runtime. The connection manager already caches
 * the connection and its manifest, so a connected environment costs a map
 * lookup here.
 *
 * A runtime the hub cannot reach has no `gh` the hub can run, so an unreachable
 * environment is unavailable rather than probed again — any such probe would
 * travel through the connection that just failed. A runtime built before the
 * `gh` manifest key existed reports absent, which reads the same way: it ships
 * no `gh.*` handler either.
 *
 * @example
 * if (!(await isGhAvailable({ userId, environmentId }))) return { state: 'gh-not-installed' };
 */
export async function isGhAvailable(
  selection: GhRuntimeSelection = LOCAL_GH_SELECTION
): Promise<boolean> {
  try {
    const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
    return runtime.manifest.gh?.available ?? false;
  } catch {
    return false;
  }
}

/**
 * Creates the typed command facade and owns the authentication probe cache.
 *
 * Every dependency the tests need to replace arrives here rather than through a
 * module global, so a fake runs without touching the connection manager.
 *
 * @example
 * const cli = createGhCli({ runner: fakeRunner });
 * await cli.viewRepo('/repo', { userId, environmentId });
 */
export function createGhCli(options: CreateGhCliOptions = {}): GithubCli {
  const execute = options.runner ?? runGh;
  const available = options.available ?? isGhAvailable;
  const probeCwd = options.probeCwd ?? runtimeHomeDir;

  // `gh auth status` answers for a whole machine, not a directory: it works
  // outside any repository, and its answer cannot vary between two workdirs on
  // one host. So it is probed once per environment, from that runtime's home
  // directory — a path the manifest already proves exists over there — rather
  // than once per workdir against a cwd the caller happened to supply.
  const isAuthenticated = createEnvironmentProbeCache({
    probe: async (selection) =>
      await execute(['auth', 'status'], {
        cwd: await probeCwd(selection),
        userId: selection.userId,
        environmentId: selection.environmentId,
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    now: options.now ?? Date.now,
    ttlMs: options.probeCacheTtlMs ?? PROBE_CACHE_TTL_MS,
  });

  const read =
    (args: readonly string[]) =>
    (cwd: string, selection: GhRuntimeSelection, signal?: AbortSignal) =>
      execute(args, {
        cwd,
        userId: selection.userId,
        environmentId: selection.environmentId,
        ...(signal ? { signal } : {}),
      });

  return {
    isAvailable: available,
    isAuthenticated,
    viewRepo: read(['repo', 'view', '--json', GH_REPO_FIELDS]),
    viewCurrentPr: read(['pr', 'view', '--json', GH_PR_FIELDS]),
  };
}

export const ghCli = createGhCli();

/** The selected runtime's own home directory, which exists on that machine. */
async function runtimeHomeDir(selection: GhRuntimeSelection): Promise<string> {
  const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
  return runtime.manifest.homeDir;
}

function mapGhFailure(args: readonly string[], error: unknown): GhCliError {
  if (isAbortError(error)) {
    return new GhCliError(args, null, 'GitHub CLI command aborted.', true);
  }
  if (error instanceof RuntimeRemoteError && detailString(error, 'kind') === 'gh_execution') {
    return new GhCliError(
      detailStringArray(error, 'args') ?? args,
      detailExitCode(error),
      detailString(error, 'stderr') ?? error.message,
      detailBoolean(error, 'aborted'),
      detailString(error, 'stdout') ?? ''
    );
  }
  if (error instanceof Error) {
    return new GhCliError(args, null, error.message);
  }
  return new GhCliError(args, null, 'GitHub CLI command failed.');
}
