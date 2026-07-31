/**
 * Low-level shell command execution for the shell builtin tools.
 * Wraps Bun.spawn so tool code never touches the raw child-process API.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { RuntimeServiceError } from '../errors';
import type { RuntimeShellResult } from '../methods';
import { type ShellEnvPolicy, sanitizeShellEnv } from './shell-env';

/** Shell interpreters exposed as tools. */
export type ShellKind = RuntimeShellResult['shell'];

export class ShellExecutionError extends RuntimeServiceError {
  constructor(message: string) {
    super('shell_execution', message);
    this.name = 'ShellExecutionError';
  }
}

/** Why a shell child process ended, distinct from raw exitCode/signal facts. */
type ShellTermination =
  | { kind: 'exited' }
  | { kind: 'timed_out' }
  | { kind: 'aborted' }
  | { kind: 'signalled'; signal: string };

export interface RunShellCommandInput {
  kind: ShellKind;
  command: string;
  /** Optional working directory; `~` is expanded to the home directory. */
  cwd?: string;
  /** Wall-clock budget before the process is killed. */
  timeoutMs: number;
  /** Per-stream cap; output beyond this is dropped and flagged truncated. */
  maxOutputBytes: number;
  /** Operator overrides for which env vars reach the child (secrets stripped by default). */
  envPolicy?: ShellEnvPolicy;
  /** When aborted, the child process is killed immediately. */
  signal?: AbortSignal;
}

export interface ShellCommandResult extends RuntimeShellResult {
  /** Authoritative termination cause; use this instead of inferring from signal alone. */
  termination: ShellTermination;
}

/** Injectable seams for deterministic race tests. */
export interface ShellExecDependencies {
  spawn: typeof Bun.spawn;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  now: () => number;
}

const defaultDeps: ShellExecDependencies = {
  spawn: Bun.spawn.bind(Bun),
  setTimeout,
  clearTimeout,
  now: () => Date.now(),
};

const executableCache = new Map<ShellKind, string | null>();

type TerminationClaim = 'timed_out' | 'aborted';

/**
 * Resolves the executable path for a shell kind, honoring platform rules.
 * PowerShell is Windows-only per product requirement; bash/zsh follow PATH.
 * The PATH lookup is memoized — shell availability is stable for a process, so
 * startup registration and per-test expectations avoid repeated `Bun.which` scans.
 *
 * // Usage: findShellExecutable('bash') // => '/usr/bin/bash' | null
 */
export function findShellExecutable(kind: ShellKind): string | null {
  const cached = executableCache.get(kind);
  if (cached !== undefined) return cached;

  const resolved = resolveShellExecutable(kind);
  executableCache.set(kind, resolved);
  return resolved;
}

/** Performs the uncached PATH lookup for a shell kind. */
function resolveShellExecutable(kind: ShellKind): string | null {
  if (kind === 'powershell') {
    if (process.platform !== 'win32') return null;
    return Bun.which('pwsh') ?? Bun.which('powershell');
  }
  return Bun.which(kind);
}

/** Reports whether a shell kind can run on the current system. */
export function isShellAvailable(kind: ShellKind): boolean {
  return findShellExecutable(kind) !== null;
}

/**
 * Runs a command through the given shell and returns captured output.
 * The process is killed after `timeoutMs`; output is capped at `maxOutputBytes`.
 *
 * // Usage: await runShellCommand({ kind: 'bash', command: 'echo hi', timeoutMs: 5000, maxOutputBytes: 65536 })
 */
export function runShellCommand(
  input: RunShellCommandInput,
  deps: Partial<ShellExecDependencies> = {}
): Promise<ShellCommandResult> {
  return runShellCommandWithDeps(input, { ...defaultDeps, ...deps });
}

/** @internal Testable entry with explicit dependency injection. */
export async function runShellCommandWithDeps(
  input: RunShellCommandInput,
  deps: ShellExecDependencies
): Promise<ShellCommandResult> {
  const executable = findShellExecutable(input.kind);
  if (!executable) {
    throw new ShellExecutionError(`The "${input.kind}" shell is not available on this system.`);
  }

  const startedAt = deps.now();
  const proc = spawnShell(deps.spawn, executable, input);
  let claimed: TerminationClaim | null = null;

  const claim = (kind: TerminationClaim): boolean => {
    if (claimed) return false;
    claimed = kind;
    return true;
  };

  const killChild = () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Process may already have exited.
    }
  };

  const naturallyExited = () => proc.exitCode !== null && proc.signalCode === null;

  const timeoutId = deps.setTimeout(() => {
    if (naturallyExited()) return;
    if (claim('timed_out')) killChild();
  }, input.timeoutMs);

  const abortHandler = () => {
    if (naturallyExited()) return;
    if (claim('aborted')) killChild();
  };
  input.signal?.addEventListener('abort', abortHandler, { once: true });
  // A signal already aborted at spawn time never re-dispatches `abort` to a
  // freshly added listener, so kill the child directly instead of leaking it
  // until its own timeout.
  if (input.signal?.aborted) abortHandler();

  try {
    const [stdout, stderr] = await Promise.all([
      readStreamCapped(proc.stdout, input.maxOutputBytes),
      readStreamCapped(proc.stderr, input.maxOutputBytes),
    ]);
    await proc.exited;

    return {
      shell: input.kind,
      command: input.command,
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      termination: resolveTermination(claimed, proc.signalCode),
      durationMs: deps.now() - startedAt,
    };
  } finally {
    deps.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortHandler);
  }
}

function resolveTermination(
  claimed: TerminationClaim | null,
  signalCode: string | null
): ShellTermination {
  if (claimed === 'timed_out') return { kind: 'timed_out' };
  if (claimed === 'aborted') return { kind: 'aborted' };
  if (signalCode) return { kind: 'signalled', signal: signalCode };
  return { kind: 'exited' };
}

function spawnShell(spawn: typeof Bun.spawn, executable: string, input: RunShellCommandInput) {
  const cwd = resolveWorkingDirectory(input.cwd);
  try {
    return spawn(buildInvocation(input.kind, executable, input.command), {
      ...(cwd ? { cwd } : {}),
      // Withhold connector API keys and the auth secret from AI-run commands.
      env: sanitizeShellEnv(input.envPolicy),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start shell process';
    throw new ShellExecutionError(`Cannot run ${input.kind} command: ${message}`);
  }
}

/** Builds the argv that runs `command` non-interactively in the given shell. */
function buildInvocation(kind: ShellKind, executable: string, command: string): string[] {
  if (kind === 'powershell') {
    return [executable, '-NoProfile', '-NonInteractive', '-Command', command];
  }
  return [executable, '-c', command];
}

function resolveWorkingDirectory(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return resolve(expandHome(cwd));
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

interface CappedRead {
  text: string;
  truncated: boolean;
}

/**
 * Reads a byte stream, retaining at most `maxBytes` worth of data.
 * Continues draining the stream past the cap (discarding bytes) so the child
 * never blocks on a full pipe; flags `truncated` when any bytes were dropped.
 */
async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<CappedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total >= maxBytes) {
        truncated = true;
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }

  return { text: decodeCapped(chunks, maxBytes), truncated };
}

function decodeCapped(chunks: Uint8Array[], maxBytes: number): string {
  const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged.subarray(0, maxBytes));
}
