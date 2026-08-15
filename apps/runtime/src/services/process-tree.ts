/**
 * Terminating a child *and everything it started*.
 *
 * Killing the direct child alone is not enough for any process the runtime
 * spawns on the hub's behalf: a descendant that survives inherits the stdout and
 * stderr pipes, so the reader never sees EOF and the call that owns it never
 * returns. Reaping the tree is platform-specific, so it lives here in one
 * spelling rather than at each spawn site.
 *
 * A child only has a tree to reap if it was spawned as its own group leader —
 * spread {@link OWN_PROCESS_GROUP} into the spawn options for that.
 */

import { spawn } from 'node:child_process';
import { HIDDEN_WINDOW } from './process-window';

/**
 * Makes the child lead its own process group so the group can be signalled as a
 * unit. POSIX only: on Windows the flag means "outlive the parent", which is the
 * opposite of what a bounded tool call wants, and `taskkill /T` covers the tree
 * there without it.
 */
export const OWN_PROCESS_GROUP = { detached: process.platform !== 'win32' } as const;

/** Argv for the Windows tree-kill primitive; PID 0 and 1 are never valid targets. */
export function windowsTaskkillArguments(pid: number): readonly string[] {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Cannot terminate invalid Windows process tree PID ${pid}.`);
  }
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * Kills a child and its descendants, without waiting for either to be reaped.
 *
 * Fire-and-forget by design: the caller has already claimed a termination and
 * must not be able to block on the kill itself. `killDirectChild` is the
 * unconditional fallback, so a platform where the tree kill fails — a child that
 * never became a group leader, a `taskkill` that is not on PATH — still loses
 * the process it owns.
 *
 * // Usage: killProcessTree(proc.pid, () => proc.kill('SIGKILL'))
 */
export function killProcessTree(pid: number | undefined, killDirectChild: () => void): void {
  if (process.platform === 'win32') {
    if (pid !== undefined && pid > 1) spawnWindowsTaskkill(pid);
  } else if (pid !== undefined && pid > 1) {
    try {
      // Negative PID addresses the group the child leads. Both this and the
      // direct kill below run: the group call fails on a child that never
      // became leader, and succeeds without touching a child that is not in it.
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone, or the child never led one.
    }
  }

  try {
    killDirectChild();
  } catch {
    // The process already exited; nothing is left to signal.
  }
}

function spawnWindowsTaskkill(pid: number): void {
  try {
    const taskkill = spawn('taskkill', [...windowsTaskkillArguments(pid)], {
      stdio: 'ignore',
      ...HIDDEN_WINDOW,
    });
    // Nothing awaits this child, so its failure must not surface as an
    // unhandled error event on the process.
    taskkill.once('error', () => undefined);
    taskkill.unref();
  } catch {
    // taskkill is missing or refused to start; the direct kill still runs.
  }
}
