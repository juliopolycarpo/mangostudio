// Shared plumbing for the metric collectors: stderr logging, error capture,
// piped command execution, and the current commit SHA.

import { ROOT_DIR } from '../../lib/config';
import type { Failable } from './types';

/** Write a namespaced diagnostic line to stderr (keeps stdout pure JSON). */
export const stderrLog = (message: string): void => {
  process.stderr.write(`[qa-gate] ${message}\n`);
};

/**
 * Run a collector, returning its value or an `{ error }` placeholder so one
 * failing metric never aborts the whole report.
 * // Usage: const loc = await safe('loc', () => measureLoc('apps/api'));
 */
export const safe = async <T>(label: string, fn: () => Promise<T>): Promise<Failable<T>> => {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrLog(`${label} failed: ${message}`);
    return { error: message };
  }
};

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Spawn a command with piped stdio and capture stdout/stderr/exit code. */
export const runCapture = async (
  cmd: readonly string[],
  opts?: { cwd?: string }
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: opts?.cwd ?? ROOT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

/** HEAD commit SHA, or 'unknown' outside a git checkout. */
export const getCommitSha = (): string => {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT_DIR });
  return result.success ? result.stdout.toString().trim() : 'unknown';
};
