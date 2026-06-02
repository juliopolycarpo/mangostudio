/**
 * Low-level shell command execution for the shell builtin tools.
 * Wraps Bun.spawn so tool code never touches the raw child-process API.
 */

import { resolve } from 'node:path';
import { expandHome } from './_fs-utils';
import { type ShellEnvPolicy, sanitizeShellEnv } from './_shell-env';

/** Shell interpreters exposed as tools. */
export type ShellKind = 'bash' | 'zsh' | 'powershell';

export class ShellExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellExecutionError';
  }
}

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
}

export interface ShellCommandResult {
  shell: ShellKind;
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Resolves the executable path for a shell kind, honoring platform rules.
 * PowerShell is Windows-only per product requirement; bash/zsh follow PATH.
 *
 * // Usage: findShellExecutable('bash') // => '/usr/bin/bash' | null
 */
export function findShellExecutable(kind: ShellKind): string | null {
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
export async function runShellCommand(input: RunShellCommandInput): Promise<ShellCommandResult> {
  const executable = findShellExecutable(input.kind);
  if (!executable) {
    throw new ShellExecutionError(`The "${input.kind}" shell is not available on this system.`);
  }

  const startedAt = Date.now();
  const proc = spawnShell(executable, input);

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
    timedOut: proc.signalCode === 'SIGKILL',
    durationMs: Date.now() - startedAt,
  };
}

function spawnShell(executable: string, input: RunShellCommandInput) {
  const cwd = resolveWorkingDirectory(input.cwd);
  try {
    return Bun.spawn(buildInvocation(input.kind, executable, input.command), {
      ...(cwd ? { cwd } : {}),
      // Withhold connector API keys and the auth secret from AI-run commands.
      env: sanitizeShellEnv(input.envPolicy),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: input.timeoutMs,
      killSignal: 'SIGKILL',
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
