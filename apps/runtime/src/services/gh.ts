/**
 * Hardened GitHub CLI spawn for the runtime protocol (`gh.exec`, `gh.mutate`).
 *
 * Argv-array-only — never a shell command string — and, unlike `git.exec`,
 * subcommand-allowlisted rather than shape-validated. Git's argv reaches this
 * boundary from code that composed it; `gh` reaches a network API that can
 * delete repositories, merge pull requests, and rewrite releases, so the
 * stricter posture the hub-side implementation established is kept here rather
 * than relaxed on the way across the wire.
 *
 * Two methods, two lists. `gh.exec` runs the read half and `gh.mutate` the
 * write half, because the consent gate decides from the method name before a
 * handler sees a parameter (see `consent-gate.ts`). The split is enforced twice
 * on purpose: by capability at dispatch, and structurally here, so `gh.exec`
 * refuses `pr create` even if the hub asks it to.
 *
 * No token variable is ever forwarded. `gh` authenticates from its own config
 * on the target machine, which means the hub cannot lend it credentials and a
 * leaked argv or stderr has no token in it to leak.
 */

import { isPinnedGithubGraphqlDocument } from '@mangostudio/shared/github';
import { RuntimeServiceError, RuntimeToolArgumentError } from '../errors';
import type { RuntimeGhExecParams, RuntimeGhExecResult } from '../methods';
import { readStreamCapped } from './child-output';
import { HIDDEN_WINDOW } from './process-window';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * How long a reader gets, after `gh` has exited, to drain an already-buffered
 * chunk before it is treated as blocked on a surviving child. `gh` shells out
 * to `git`, which shells out to credential helpers, so the same inherited-pipe
 * problem `git.exec` documents applies here one level deeper.
 */
const EXIT_DRAIN_GRACE_MS = 50;

const GH_ENV_KEYS = [
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
  // `gh help environment`: with no `GH_CONFIG_DIR`, gh's default config
  // location on Windows is `$AppData/GitHub CLI`. Dropping this made every
  // Windows runtime without an explicit `GH_CONFIG_DIR` unable to find the
  // config a normal `gh auth login` wrote, so the panel reported the account
  // as unauthenticated regardless of what `gh auth status` would say directly.
  'APPDATA',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // `pr checkout` shells out to `git fetch`, which needs the SSH agent socket
  // to authenticate an `ssh://`/`git@` remote the same way `buildGitEnvironment`
  // already forwards it for direct Git calls. It is a socket path, not a
  // credential, so carrying it does not reintroduce what the token exclusion
  // below guards against.
  'SSH_AUTH_SOCK',
  // Deliberately absent: GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN and every
  // other credential variable. `gh` reads its own keyring/config; forwarding a
  // token would let this process's environment authenticate as somebody else
  // and would put a secret into a child that logs its own argv on failure.
] as const;

/**
 * Subcommands `gh.exec` may run: everything that only reads GitHub.
 *
 * Keyed by the first one or two argv tokens, which is the whole of what a `gh`
 * subcommand is. Flags after that shape the read; they cannot turn it into a
 * write — with one exception, `api`, handled separately below.
 */
const READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  '--version',
  'auth status',
  'repo view',
  'pr view',
  'pr list',
  'pr status',
  'pr checks',
  'issue list',
  'search prs',
  'api graphql',
]);

/**
 * Subcommands `gh.mutate` may run: the ones that change something.
 *
 * `pr checkout` is here rather than with the reads because it writes to the
 * working tree — it fetches a ref and switches branches — even though it asks
 * GitHub only to read.
 */
const WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['pr create', 'pr ready', 'pr checkout']);

/**
 * Flags refused on every subcommand, plus the short aliases — those refused
 * everywhere, and the one that only means a refused flag where gh says it does.
 *
 * Naming a subcommand is not the same as bounding it: the allowlists above key
 * on the first one or two tokens, and everything after that is gh's to
 * interpret. Two of those flags turn an allowlisted read into something this
 * boundary exists to prevent.
 *
 * `--show-token` is the serious one. `gh auth status --show-token` prints the
 * stored GitHub token on stdout, and stdout is what the hub reads back as the
 * result — so a single flag manufactures the credential this whole design is
 * built on not having. `buildGhEnvironment` refuses to *forward* a token for
 * exactly that reason; letting one be read back out through gh's own output
 * would undo it from the other end.
 *
 * `--web` opens a browser on whichever machine the runtime is, which is not the
 * machine the person is looking at. Harmless on a headless host and a genuine
 * surprise on a desktop one, and either way it is an effect, not a read.
 *
 * The short aliases split two ways, and the split is what the letters actually
 * mean rather than which subcommands happen to be listed here. `-w` is
 * `--web` on *every* gh subcommand that defines it — `repo view`, `pr view`,
 * `pr list`, `pr checks`, `issue list`, `search prs` and `pr create` alike, and
 * `gh pr checks` spells its watch mode `--watch` with no short alias — so it is
 * refused globally. `-t` cannot be: gh spells `--show-token` `-t` on
 * `auth status` and `--title` `-t` on `pr create`, so refusing that letter
 * everywhere would forbid opening a pull request. Only genuinely overloaded
 * letters get a per-subcommand entry.
 *
 * This is a denylist, unlike the `gh api` flags below, and that is the weaker
 * shape — it has to be right about every spelling, forever. It is used here
 * because the alternative is a per-subcommand flag allowlist for nine
 * subcommands whose flag sets are gh's to change; the hub builds these argvs
 * from a closed registry, so this is the second lock rather than the only one.
 */
const REFUSED_FLAGS: ReadonlySet<string> = new Set(['--show-token', '--web']);

/** Letters that mean the same refused flag on every subcommand that has them. */
const GLOBAL_REFUSED_SHORT_LETTERS: ReadonlySet<string> = new Set(['w']);

/** Letters gh overloads, refused only where they spell a refused flag. */
const REFUSED_SHORT_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['auth status', new Set(['t'])],
]);

/**
 * Flags `gh api` may carry, and nothing else.
 *
 * This is an allowlist rather than a denylist of the dangerous ones (`-X`,
 * `--method`, `--input`, `--paginate`, `-q`, `--jq`) because a denylist has to
 * be right about every spelling of every flag `gh` will ever add, and it only
 * has to be wrong once. Anything not named here is refused, in every spelling.
 */
const GH_API_FIELD_FLAGS: ReadonlySet<string> = new Set(['-f', '--raw-field', '-F', '--field']);

/** The single field flag a GraphQL document may arrive on. */
const GH_API_RAW_FIELD_FLAGS: ReadonlySet<string> = new Set(['-f', '--raw-field']);

export class GhExecutionError extends RuntimeServiceError {
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
    super('gh_execution', message, data);
    this.name = 'GhExecutionError';
  }
}

/** Builds the direct argv passed to Bun.spawn; no shell is involved. */
export function buildGhArgv(args: readonly string[]): string[] {
  return ['gh', ...args];
}

/**
 * Keeps only the process state `gh` needs, then forces non-interactive,
 * parse-stable behavior. Token variables are never carried across.
 */
export function buildGhEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of GH_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.NO_COLOR = '1';
  env.LC_ALL = 'C';
  return env;
}

/**
 * Runs a read-only `gh` subcommand.
 *
 * @example
 * await execGh({ args: ['pr', 'view', '--json', 'number'], cwd: '/repo' });
 */
export function execGh(
  params: RuntimeGhExecParams,
  signal?: AbortSignal
): Promise<RuntimeGhExecResult> {
  return runGh('gh.exec', READ_SUBCOMMANDS, params, signal);
}

/**
 * Runs a mutating `gh` subcommand. Reaches here only when the machine granted
 * `shell` as well as `git`.
 *
 * @example
 * await mutateGh({ args: ['pr', 'create', '--fill'], cwd: '/repo' });
 */
export function mutateGh(
  params: RuntimeGhExecParams,
  signal?: AbortSignal
): Promise<RuntimeGhExecResult> {
  return runGh('gh.mutate', WRITE_SUBCOMMANDS, params, signal);
}

/**
 * Summarizes a `gh` argv down to its subcommand tokens, for audit lines.
 *
 * Never the full argv: `gh pr create --title ... --body ...` carries prose a
 * user wrote, and the audit scrubber is best-effort pattern matching. Two
 * tokens name the operation, which is what an audit trail is for.
 *
 * @example
 * summarizeGhSubcommand(['pr', 'create', '--title', 'Fix']); // ['pr', 'create']
 */
export function summarizeGhSubcommand(args: readonly unknown[]): readonly string[] {
  return args.filter((entry): entry is string => typeof entry === 'string').slice(0, 2);
}

async function runGh(
  method: 'gh.exec' | 'gh.mutate',
  allowed: ReadonlySet<string>,
  params: RuntimeGhExecParams,
  signal?: AbortSignal
): Promise<RuntimeGhExecResult> {
  const { args, cwd, timeoutMs, acceptedExitCodes } = validateGhExecParams(method, allowed, params);

  let proc: ReturnType<typeof spawnGh>;
  try {
    proc = spawnGh(args, cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to start GitHub CLI.';
    throw new GhExecutionError(detail, { exitCode: null, stderr: detail, stdout: '', args });
  }

  let termination: 'timeout' | 'abort' | null = null;
  // `gh` starts `git`, and `git` starts credential helpers. One of those can
  // outlive the kill holding these pipes, so waiting for EOF would wait
  // forever; releasing the readers is what bounds the call. Same reasoning as
  // `services/git.ts`, one process deeper.
  const terminated = new AbortController();

  const kill = (reason: 'timeout' | 'abort') => {
    if (termination) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      terminated.abort();
      return;
    }
    termination = reason;
    try {
      proc.kill('SIGKILL');
    } catch {
      // The child may have exited between the state check and kill.
    }
    terminated.abort();
  };

  const timeoutId = setTimeout(() => kill('timeout'), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortHandler = () => kill('abort');
  signal?.addEventListener('abort', abortHandler, { once: true });
  if (signal?.aborted) abortHandler();
  // Stop the capture once `gh` itself is gone rather than waiting for the
  // timeout — but not in the same tick. Cancelling the instant `exited`
  // resolves races the reader's pending `read()` against the abort, and an
  // ordinary capture that was already fully written can lose that race and be
  // misreported as `stopped`. The grace window lets a closed pipe's last
  // buffered chunk arrive first; a reader still blocked after it is one a
  // surviving child is genuinely holding open. Unref'd because a 50ms handle
  // outliving the call would delay process exit for a short-lived invocation.
  void proc.exited.then(() => {
    const graceId = setTimeout(() => terminated.abort(), EXIT_DRAIN_GRACE_MS);
    graceId.unref?.();
  });

  try {
    const [stdout, stderr] = await Promise.all([
      readStreamCapped(proc.stdout, MAX_OUTPUT_BYTES, terminated.signal),
      readStreamCapped(proc.stderr, MAX_OUTPUT_BYTES, terminated.signal),
    ]);
    const exitCode = await proc.exited;

    if (termination === 'abort') {
      throw new GhExecutionError('GitHub CLI command aborted.', {
        exitCode,
        stderr: 'GitHub CLI command aborted.',
        stdout: '',
        args,
        aborted: true,
      });
    }
    if (termination === 'timeout') {
      throw new GhExecutionError('GitHub CLI command timed out.', {
        exitCode,
        stderr: 'GitHub CLI command timed out.',
        stdout: '',
        args,
      });
    }
    if (stdout.truncated || stderr.truncated) {
      const message = `GitHub CLI output exceeded ${MAX_OUTPUT_BYTES} bytes.`;
      throw new GhExecutionError(message, { exitCode, stderr: message, stdout: '', args });
    }
    if (exitCode !== 0 && !acceptedExitCodes?.includes(exitCode)) {
      throw new GhExecutionError(
        stderr.text.trim() || stdout.text.trim() || 'GitHub CLI command failed.',
        {
          exitCode,
          stderr: stderr.text.trim(),
          stdout: stdout.text.trim(),
          args,
        }
      );
    }

    // Distinct from `truncated`: a `stopped` reader was cancelled before EOF,
    // not cut at the byte cap, so its text may be short of what `gh` wrote.
    // The hub rejects an incomplete capture rather than parsing it, because a
    // half-read `--json` payload is a wrong answer shaped like a right one.
    const incomplete = stdout.stopped || stderr.stopped;
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      ...(incomplete ? { incomplete: true } : {}),
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortHandler);
  }
}

/**
 * Hand-written because wire params are not schema-validated: the protocol
 * declares `params: Type.Unknown()` on the request frame, so everything below
 * arrives as whatever the peer sent.
 */
function validateGhExecParams(
  method: 'gh.exec' | 'gh.mutate',
  allowed: ReadonlySet<string>,
  params: RuntimeGhExecParams
): {
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  acceptedExitCodes?: readonly number[];
} {
  if (!Array.isArray(params.args) || params.args.some((arg) => typeof arg !== 'string')) {
    throw new RuntimeToolArgumentError(`${method} requires args to be an array of strings.`);
  }
  if (params.args.some((arg) => arg.includes('\0'))) {
    throw new RuntimeToolArgumentError(`${method} args must not contain NUL bytes.`);
  }
  if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
    throw new RuntimeToolArgumentError(`${method} requires a non-empty cwd string.`);
  }
  // Both cross the wire untyped: a non-positive timeout fires the kill timer
  // immediately, and a non-array acceptedExitCodes throws a raw TypeError at
  // the exit-code check instead of a structured protocol error.
  if (
    params.timeoutMs !== undefined &&
    (typeof params.timeoutMs !== 'number' ||
      !Number.isFinite(params.timeoutMs) ||
      params.timeoutMs <= 0)
  ) {
    throw new RuntimeToolArgumentError(`${method} timeoutMs must be a positive finite number.`);
  }
  if (
    params.acceptedExitCodes !== undefined &&
    (!Array.isArray(params.acceptedExitCodes) ||
      params.acceptedExitCodes.some((code) => !Number.isInteger(code)))
  ) {
    throw new RuntimeToolArgumentError(`${method} acceptedExitCodes must be an array of integers.`);
  }
  // Reject a legacy/string command field if a caller smuggles it onto the object.
  if ('command' in params && (params as { command?: unknown }).command !== undefined) {
    throw new RuntimeToolArgumentError(
      `${method} does not accept a command string; pass argv as args.`
    );
  }
  assertAllowedSubcommand(method, allowed, params.args);
  return {
    args: params.args,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    acceptedExitCodes: params.acceptedExitCodes,
  };
}

function assertAllowedSubcommand(
  method: 'gh.exec' | 'gh.mutate',
  allowed: ReadonlySet<string>,
  args: readonly string[]
): void {
  const subcommand = subcommandKey(args);
  if (!subcommand || !allowed.has(subcommand)) {
    throw new RuntimeToolArgumentError(
      `${method} refuses "gh ${subcommand ?? args.join(' ')}": it is not on this method's subcommand allowlist.`
    );
  }
  assertNoRefusedFlag(method, subcommand, args);
  if (subcommand === 'api graphql') assertPinnedGraphqlCall(method, args);
}

/**
 * Refuses the flags that would turn an allowlisted subcommand into a token
 * disclosure or a side effect on the runtime's own desktop.
 *
 * Long flags are matched on the bare token: gh accepts `--web` and
 * `--web=true` alike, so matching only the bare token would leave the `=`
 * form open. Short flags need more than that, because gh's underlying flag
 * parser (pflag) clusters single-letter boolean flags together and accepts
 * `=` on them too: `-at` means `-a -t`, and `-t=true` is `-t` with an
 * explicit value. Matching the argv token verbatim against `-t` misses both,
 * so a refused letter is checked against every letter in a short-flag
 * cluster instead.
 */
function assertNoRefusedFlag(
  method: 'gh.exec' | 'gh.mutate',
  subcommand: string,
  args: readonly string[]
): void {
  const scoped = REFUSED_SHORT_FLAGS.get(subcommand);

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!REFUSED_FLAGS.has(flag)) continue;
      throw new RuntimeToolArgumentError(
        `${method} refuses "gh ${subcommand} ${flag}": it discloses credentials or acts outside this call.`
      );
    }
    const cluster = shortFlagCluster(arg);
    if (cluster === null) continue;
    const refused = [...cluster].some(
      (letter) => GLOBAL_REFUSED_SHORT_LETTERS.has(letter) || scoped?.has(letter) === true
    );
    if (!refused) continue;
    throw new RuntimeToolArgumentError(
      `${method} refuses "gh ${subcommand} ${arg}": it discloses credentials or acts outside this call.`
    );
  }
}

/**
 * The letters of a short-flag cluster (`-w`, `-at`, `-t=true`), or `null` when
 * the token is not one.
 *
 * The shape test is what keeps free text out of the scan. Refusing `-w`
 * globally means every argument of every subcommand reaches this function,
 * including operands a subcommand takes verbatim — a `pr create` body sent as
 * its own argv element rather than as `--body=`, say. `- what changed` starts
 * with a dash and contains a `w`, and it is a markdown bullet, not `--web`;
 * pflag would not read it as a flag either, since a cluster is letters up to
 * the end of the token or an `=`.
 *
 * @example
 * shortFlagCluster('-at'); // 'at'
 * shortFlagCluster('- what changed'); // null
 */
function shortFlagCluster(arg: string): string | null {
  return /^-([A-Za-z]+)(?:=|$)/.exec(arg)?.[1] ?? null;
}

/** The first one or two argv tokens, which is what names a `gh` subcommand. */
function subcommandKey(args: readonly string[]): string | null {
  const [first, second] = args;
  if (first === undefined) return null;
  if (first === '--version') return args.length === 1 ? '--version' : null;
  if (second === undefined) return null;
  return `${first} ${second}`;
}

/**
 * The one dangerous token, made safe by construction.
 *
 * `gh api` speaks the whole GitHub API — `gh api repos/o/r -X DELETE` deletes a
 * repository — so it is never allowlisted bare. Only `api graphql` is reachable,
 * only with field flags, and the document itself must be one shared pinned,
 * checked against the same constant the hub imports rather than against
 * anything the hub sent. A membership test on a caller-supplied list would only
 * prove the caller agreed with itself.
 */
function assertPinnedGraphqlCall(method: 'gh.exec' | 'gh.mutate', args: readonly string[]): void {
  let pinnedQueries = 0;
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1];
    if (!GH_API_FIELD_FLAGS.has(flag)) {
      throw new RuntimeToolArgumentError(
        `${method} refuses "gh api graphql ${flag}": only -f/-F field flags are accepted.`
      );
    }
    if (typeof value !== 'string' || !value.includes('=')) {
      throw new RuntimeToolArgumentError(
        `${method} requires every "gh api graphql" field to be a key=value token.`
      );
    }
    const separator = value.indexOf('=');
    const key = value.slice(0, separator);
    const fieldValue = value.slice(separator + 1);
    // `-F name=@file` makes gh read a file off the target machine and post it.
    if (fieldValue.startsWith('@')) {
      throw new RuntimeToolArgumentError(
        `${method} refuses a "gh api graphql" field value that reads a file.`
      );
    }
    if (key !== 'query') continue;
    if (!GH_API_RAW_FIELD_FLAGS.has(flag)) {
      throw new RuntimeToolArgumentError(
        `${method} requires the GraphQL document to be passed as -f query=.`
      );
    }
    if (!isPinnedGithubGraphqlDocument(fieldValue)) {
      throw new RuntimeToolArgumentError(
        `${method} refuses a GraphQL document that is not one of this build's pinned documents.`
      );
    }
    pinnedQueries += 1;
  }
  if (pinnedQueries !== 1) {
    throw new RuntimeToolArgumentError(
      `${method} requires "gh api graphql" to carry exactly one pinned -f query= document.`
    );
  }
}

function spawnGh(args: readonly string[], cwd: string) {
  return Bun.spawn(buildGhArgv(args), {
    cwd,
    env: buildGhEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...HIDDEN_WINDOW,
  });
}
