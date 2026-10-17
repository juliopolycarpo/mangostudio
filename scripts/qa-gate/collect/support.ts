// Shared plumbing for the metric collectors: stderr logging, error capture,
// piped command execution, and the current commit SHA.

import { ROOT_DIR } from '../../lib/config';
import {
  bindDescendantsToRunner,
  ChildSupervisor,
  isNestedRunner,
  processHost,
  RUNNER_GROUP_ENV,
  supervisionMode,
} from '../../lib/process-tree';
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

const captureSupervisor = new ChildSupervisor(processHost());
let nestedCapture: boolean | undefined;

// The supervisor owns the signal exit. A cancelled capture must not return a
// result while its descendants are still stopping, even if the leader exited.
const cancellationExit = (): Promise<never> => new Promise(() => undefined);

/**
 * Capture a command's output and exit while retaining ownership through pipe
 * draining. Root POSIX captures own a group; nested runners keep their owner's
 * group and Windows uses the existing kill-on-close job binding.
 * @example await runCapture(['bunx', 'tsc', '--noEmit'])
 */
export const runCapture = async (
  cmd: readonly string[],
  opts?: { cwd?: string }
): Promise<RunResult> => {
  if (captureSupervisor.cancelling) return cancellationExit();
  await bindDescendantsToRunner();
  if (captureSupervisor.cancelling) return cancellationExit();
  // Retain the original owner even if its group's leader exits during capture.
  nestedCapture ??= process.platform !== 'win32' && isNestedRunner();
  const ownsGroup = supervisionMode('ignore', process.platform, nestedCapture) === 'group';
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: opts?.cwd ?? ROOT_DIR,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: ownsGroup ? { ...process.env, [RUNNER_GROUP_ENV]: String(process.pid) } : process.env,
    detached: ownsGroup,
  });
  const release = ownsGroup
    ? captureSupervisor.adopt({
        label: cmd[0] ?? 'captured command',
        pid: proc.pid,
        ownsGroup: true,
        exited: proc.exited,
        signal: (signal) => proc.kill(signal),
      })
    : undefined;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (captureSupervisor.cancelling) return await cancellationExit();
    return { stdout, stderr, exitCode };
  } finally {
    await proc.exited;
    release?.();
  }
};

/** HEAD commit SHA, or 'unknown' outside a git checkout. */
export const getCommitSha = (): string => {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT_DIR });
  return result.success ? result.stdout.toString().trim() : 'unknown';
};
