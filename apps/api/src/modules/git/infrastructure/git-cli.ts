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
] as const;

export interface RunGitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
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

interface CappedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

let availabilityProbe: Promise<boolean> | null = null;

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

/** Runs Git with bounded output and fails with structured, log-safe command context. */
export async function runGit(
  args: readonly string[],
  options: RunGitOptions
): Promise<GitCommandResult> {
  let proc: ReturnType<typeof spawnGit>;
  try {
    proc = spawnGit(args, options.cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to start Git.';
    throw new GitCliError(args, null, detail);
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
      throw new GitCliError(args, exitCode, 'Git command aborted.', true);
    }
    if (termination === 'timeout') {
      throw new GitCliError(args, exitCode, 'Git command timed out.');
    }
    if (stdout.truncated || stderr.truncated) {
      throw new GitCliError(args, exitCode, `Git output exceeded ${MAX_OUTPUT_BYTES} bytes.`);
    }
    if (exitCode !== 0) {
      throw new GitCliError(args, exitCode, stderr.text, false, stdout.text);
    }

    return { stdout: stdout.text, stderr: stderr.text, exitCode };
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortHandler);
  }
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

/** Probes Git once per process; availability is stable for the lifetime of the server. */
export function isGitAvailable(): Promise<boolean> {
  availabilityProbe ??= runGit(['--version'], { cwd: process.cwd(), timeoutMs: 5_000 }).then(
    () => true,
    () => false
  );
  return availabilityProbe;
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
