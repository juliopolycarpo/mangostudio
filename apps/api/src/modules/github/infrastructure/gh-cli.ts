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
import { exceedsWindowsCommandLine } from '../domain/gh-command-line';
import {
  buildGhCommandArgv,
  GH_COMMAND_SPECS,
  type GhCommandId,
  type GhCommandParams,
} from '../domain/gh-command-registry';
import { createEnvironmentProbeCache, type ProbeEnvironmentKey } from './environment-probe-cache';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 60_000;

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
  /**
   * Non-zero exits this command uses to report rather than to fail.
   *
   * Forwarded to the runtime, which owns the exit-code check. `gh pr checks`
   * needs it: it exits 1 on a failing check and 8 on a pending one while still
   * printing the JSON, so without this every red or running pull request would
   * be a 500 on a read-only panel.
   */
  readonly acceptedExitCodes?: readonly number[];
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

/** Where one command runs: a directory, on a machine, for a request. */
export interface GhCommandTarget {
  readonly cwd: string;
  readonly selection: GhRuntimeSelection;
  readonly signal?: AbortSignal;
}

export interface GithubCli {
  readonly isAvailable: (selection: GhRuntimeSelection) => Promise<boolean>;
  readonly isAuthenticated: (selection: GhRuntimeSelection) => Promise<boolean>;
  /**
   * Runs one registered command.
   *
   * There is no per-command method on this facade any more, and that is the
   * point: a method per command is a second place to spell argv, and the
   * registry exists so there is only one. The spec also decides `gh.exec` vs
   * `gh.mutate` and which non-zero exits are reportable, so a caller cannot get
   * either wrong by forgetting an option.
   */
  readonly run: <I extends GhCommandId>(
    id: I,
    params: GhCommandParams<I>,
    target: GhCommandTarget
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
    // Before the spawn, because after it there is nothing left to say: Windows
    // refuses the whole command line and `Bun.spawn` reports that as a failure
    // to start `gh`, with nothing in it about which argument was too long.
    if (runtime.manifest.pathStyle === 'win32' && exceedsWindowsCommandLine(args)) {
      throw new GhCliError(
        args,
        null,
        'This command is too long for the Windows machine it runs on. A pull request description of about 30,000 characters is the most `gh` can be given there; shorten it, or open the pull request with a shorter description and paste the rest as a comment.'
      );
    }
    const call = options.mutation ? runtime.gh.mutate : runtime.gh.exec;
    result = await call(
      {
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        acceptedExitCodes: options.acceptedExitCodes,
      },
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

/** One account's entry under a host in `gh auth status --json hosts`. */
interface GhAuthStatusAccount {
  readonly active?: boolean;
  readonly state?: string;
}

/**
 * Reads whether *this repository's* account is authenticated from
 * `gh auth status --json hosts` output, rather than from the process's exit
 * code.
 *
 * A host can carry several accounts, only one of which is active per host,
 * and a machine can have several hosts configured. This checks every host's
 * active account rather than one named host, because the registry has no
 * per-repo host to scope it to yet — but it is still narrower than the exit
 * code, which fails on *any* account anywhere, active or not.
 *
 * `state` is undefined for hosts on gh versions that predate the field, so an
 * active account with no `state` is treated as healthy rather than unknown.
 *
 * @example
 * isGhAccountHealthy('{"hosts":{"github.com":[{"active":true,"state":"success"}]}}'); // true
 */
function isGhAccountHealthy(stdout: string): boolean {
  let hosts: Record<string, readonly GhAuthStatusAccount[]>;
  try {
    hosts =
      (JSON.parse(stdout) as { hosts?: Record<string, readonly GhAuthStatusAccount[]> }).hosts ??
      {};
  } catch {
    return false;
  }
  return Object.values(hosts).some((accounts) =>
    accounts.some(
      (account) => account.active && (account.state === undefined || account.state === 'success')
    )
  );
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
  const probeCwd = options.probeCwd ?? resolveGhHomeCwd;

  // `gh auth status` answers for a whole machine, not a directory: it works
  // outside any repository, and its answer cannot vary between two workdirs on
  // one host. So it is probed once per environment, from that runtime's home
  // directory — a path the manifest already proves exists over there — rather
  // than once per workdir against a cwd the caller happened to supply.
  //
  // The probe cache turns a rejected promise into a cached `false`, so a
  // healthy-or-not verdict has to come from *throwing* here, not from the
  // command's own exit code: the `--json` shape gh auth status runs with
  // exits 0 even when no account is authenticated at all.
  const isAuthenticated = createEnvironmentProbeCache({
    probe: async (selection) => {
      const result = await execute(buildGhCommandArgv('auth.status', {}), {
        cwd: await probeCwd(selection),
        userId: selection.userId,
        environmentId: selection.environmentId,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (!isGhAccountHealthy(result.stdout)) {
        throw new GhCliError(
          ['auth', 'status'],
          result.exitCode,
          result.stderr,
          false,
          result.stdout
        );
      }
      return result;
    },
    now: options.now ?? Date.now,
    ttlMs: options.probeCacheTtlMs ?? PROBE_CACHE_TTL_MS,
  });

  return {
    isAvailable: available,
    isAuthenticated,
    // Async so a slot that fails its contract rejects like every other failure
    // on this facade, rather than throwing synchronously into a caller that is
    // only prepared for a rejected promise.
    async run(id, params, target) {
      const spec = GH_COMMAND_SPECS[id];
      return await execute(buildGhCommandArgv(id, params), {
        cwd: target.cwd,
        userId: target.selection.userId,
        environmentId: target.selection.environmentId,
        mutation: spec.mutation,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        ...(spec.acceptedExitCodes ? { acceptedExitCodes: spec.acceptedExitCodes } : {}),
        ...(target.signal ? { signal: target.signal } : {}),
      });
    },
  };
}

export const ghCli = createGhCli();

/**
 * The selected runtime's own home directory, which exists on that machine.
 *
 * The cwd for every `gh` call that is about an account rather than a checkout —
 * `auth status` and the cross-repo inbox search both work outside a repository,
 * but `Bun.spawn` still needs a directory that exists over there.
 *
 * @example
 * const cwd = await resolveGhHomeCwd({ userId, environmentId });
 */
export async function resolveGhHomeCwd(selection: GhRuntimeSelection): Promise<string> {
  const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
  return runtime.manifest.homeDir;
}

function mapGhFailure(args: readonly string[], error: unknown): GhCliError {
  // A refusal this file raised itself already carries the argv, the exit code
  // and the sentence a user should read; re-wrapping it would replace all three
  // with `error.message` alone.
  if (error instanceof GhCliError) return error;
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
