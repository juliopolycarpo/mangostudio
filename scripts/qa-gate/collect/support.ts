// Shared plumbing for the metric collectors: stderr logging, error capture,
// piped command execution, and the current commit SHA.

import { ROOT_DIR } from '../../lib/config';
import { type Measurement, measured, unavailable } from '../model/states';

/** Write a namespaced diagnostic line to stderr (keeps stdout pure JSON). */
export const stderrLog = (message: string): void => {
  process.stderr.write(`[qa-gate] ${message}\n`);
};

const escapeAnnotation = (text: string): string =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * GitHub Actions `::error::` annotations, one per message, so a failure shows
 * on the run summary instead of only in the log. Written to stderr because
 * stdout carries the envelope JSON.
 * // Usage: process.stderr.write(errorAnnotations('QA registry', ['tools/ is unowned']))
 */
export const errorAnnotations = (title: string, messages: readonly string[]): string =>
  messages
    .map((message) => `::error title=${escapeAnnotation(title)}::${escapeAnnotation(message)}\n`)
    .join('');

/**
 * Run a collector, returning `measured(value)` or an explicit `unavailable`
 * measurement carrying the error, so one failing metric never aborts the whole
 * report and never reads as zero.
 * // Usage: const dupes = await measure('duplication', collectDuplication);
 */
export const measure = async <T>(label: string, fn: () => Promise<T>): Promise<Measurement<T>> => {
  try {
    return measured(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrLog(`${label} failed: ${message}`);
    return unavailable(message);
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
