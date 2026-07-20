const DEFAULT_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const GH_REPO_FIELDS = 'nameWithOwner,defaultBranchRef,url';
const GH_PR_FIELDS = 'number,title,state,isDraft,url,headRefName,baseRefName';

type GhCommandArgs =
  | readonly ['--version']
  | readonly ['auth', 'status']
  | readonly ['repo', 'view', '--json', typeof GH_REPO_FIELDS]
  | readonly ['pr', 'view', '--json', typeof GH_PR_FIELDS];

const ALLOWED_COMMANDS = new Set([
  JSON.stringify(['--version']),
  JSON.stringify(['auth', 'status']),
  JSON.stringify(['repo', 'view', '--json', GH_REPO_FIELDS]),
  JSON.stringify(['pr', 'view', '--json', GH_PR_FIELDS]),
]);

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
] as const;

interface RunGhOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
}

interface GhCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GhCliError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly args: readonly string[];
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

interface CappedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

export interface GithubCli {
  readonly isAvailable: (cwd: string) => Promise<boolean>;
  readonly isAuthenticated: (cwd: string) => Promise<boolean>;
  readonly viewRepo: (cwd: string, signal?: AbortSignal) => Promise<GhCommandResult>;
  readonly viewCurrentPr: (cwd: string, signal?: AbortSignal) => Promise<GhCommandResult>;
}

export type GhCommandRunner = (
  args: GhCommandArgs,
  options: RunGhOptions
) => Promise<GhCommandResult>;

interface CreateGhCliOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly probeCacheTtlMs?: number;
  readonly runner?: GhCommandRunner;
}

/** Enforces the complete command allowlist before constructing a direct argv. */
export function buildGhArgv(args: readonly string[]): string[] {
  if (!ALLOWED_COMMANDS.has(JSON.stringify(args))) {
    throw new TypeError(`Unsupported GitHub CLI command: ${args.join(' ')}`);
  }
  return ['gh', ...args];
}

/** Preserves gh configuration and network settings without forwarding token variables. */
export function buildGhEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of GH_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.GH_PROMPT_DISABLED = '1';
  environment.GH_NO_UPDATE_NOTIFIER = '1';
  environment.NO_COLOR = '1';
  environment.LC_ALL = 'C';
  return environment;
}

/** Runs one allowlisted gh command with bounded output and no shell. */
async function runGh(args: GhCommandArgs, options: RunGhOptions): Promise<GhCommandResult> {
  let proc: ReturnType<typeof spawnGh>;
  try {
    proc = spawnGh(args, options.cwd, options.environment);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to start GitHub CLI.';
    throw new GhCliError(args, null, detail);
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

  const timeoutId = setTimeout(() => kill('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortHandler = () => kill('abort');
  options.signal?.addEventListener('abort', abortHandler, { once: true });
  if (options.signal?.aborted) abortHandler();

  try {
    const [stdout, stderr] = await Promise.all([
      readStreamCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readStreamCapped(proc.stderr, MAX_OUTPUT_BYTES),
    ]);
    const exitCode = await proc.exited;

    if (termination === 'abort') {
      throw new GhCliError(args, exitCode, 'GitHub CLI command aborted.', true);
    }
    if (termination === 'timeout') {
      throw new GhCliError(args, exitCode, 'GitHub CLI command timed out.');
    }
    if (stdout.truncated || stderr.truncated) {
      throw new GhCliError(args, exitCode, `GitHub CLI output exceeded ${MAX_OUTPUT_BYTES} bytes.`);
    }
    if (exitCode !== 0) {
      throw new GhCliError(args, exitCode, stderr.text, false, stdout.text);
    }

    return { stdout: stdout.text, stderr: stderr.text, exitCode };
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortHandler);
  }
}

/**
 * Caches a boolean probe for a TTL and single-flights concurrent callers.
 *
 * Failures expire like successes so an operator who installs gh or runs
 * `gh auth login` recovers without restarting the server.
 */
function createCachedProbe(
  probe: (cwd: string) => Promise<unknown>,
  now: () => number,
  ttlMs: number
): (cwd: string) => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null;
  let cache: { readonly value: boolean; readonly expiresAt: number } | null = null;

  return (cwd) => {
    if (cache && now() < cache.expiresAt) return Promise.resolve(cache.value);
    inFlight ??= probe(cwd)
      .then(
        () => true,
        () => false
      )
      .then((value) => {
        cache = { value, expiresAt: now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/** Creates the typed command facade and owns the TTL-bounded probe caches. */
export function createGhCli(options: CreateGhCliOptions = {}): GithubCli {
  const now = options.now ?? Date.now;
  const probeCacheTtlMs = options.probeCacheTtlMs ?? PROBE_CACHE_TTL_MS;
  const execute: GhCommandRunner =
    options.runner ??
    ((args, runOptions) =>
      runGh(args, { ...runOptions, environment: options.environment ?? process.env }));

  const probe = (args: GhCommandArgs) =>
    createCachedProbe(
      (cwd) => execute(args, { cwd, timeoutMs: PROBE_TIMEOUT_MS }),
      now,
      probeCacheTtlMs
    );

  return {
    isAvailable: probe(['--version']),
    isAuthenticated: probe(['auth', 'status']),
    viewRepo(cwd, signal) {
      return execute(['repo', 'view', '--json', GH_REPO_FIELDS], { cwd, signal });
    },
    viewCurrentPr(cwd, signal) {
      return execute(['pr', 'view', '--json', GH_PR_FIELDS], { cwd, signal });
    },
  };
}

export const ghCli = createGhCli();

function spawnGh(args: GhCommandArgs, cwd: string, source?: NodeJS.ProcessEnv) {
  return Bun.spawn(buildGhArgv(args), {
    cwd,
    env: buildGhEnvironment(source),
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
