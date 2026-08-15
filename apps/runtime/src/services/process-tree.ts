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
import { readdirSync, readFileSync } from 'node:fs';
import { HIDDEN_WINDOW } from './process-window';

/**
 * Makes the child lead its own process group so the group can be signalled as a
 * unit. POSIX only: on Windows the flag means "outlive the parent", which is the
 * opposite of what a bounded tool call wants, and `taskkill /T` covers the tree
 * there without it.
 */
export const OWN_PROCESS_GROUP = { detached: process.platform !== 'win32' } as const;

/** How long the group leader is kept alive to waitpid SIGKILL'd children. */
const LEADER_REAP_BUDGET_MS = 100;
const LEADER_REAP_POLL_MS = 5;

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
 * fallback when the tree kill cannot start, so a platform where that fails — a
 * child that never became a group leader, a `taskkill` that is not on PATH —
 * still loses the process it owns. On Windows the fallback must not race the
 * root: `/T` walks from the specified PID, and killing that PID first hides
 * the descendants.
 *
 * On Linux the group members are signalled first and the leader a moment later.
 * A single `kill(-pid, SIGKILL)` races the leader with its children, so the
 * leader never waitpids them and they land on PID 1 as zombies. Docker images
 * in this repo run the hub as PID 1, which does not reap adopted children.
 *
 * // Usage: killProcessTree(proc.pid, () => proc.kill('SIGKILL'))
 */
export function killProcessTree(pid: number | undefined, killDirectChild: () => void): void {
  if (process.platform === 'win32') {
    if (pid !== undefined && pid > 1) {
      startWindowsTaskkillTree(pid, killDirectChild);
      return;
    }
    invokeKill(killDirectChild);
    return;
  }

  if (pid !== undefined && pid > 1) {
    // Linux takes the group down a member at a time so the leader can waitpid
    // them. It declines when `/proc` is unreadable, and then the group call
    // below is the fallback — the same one every other POSIX platform takes.
    if (process.platform === 'linux' && killLinuxProcessTree(pid, killDirectChild)) return;
    try {
      // Negative PID addresses the group the child leads. Both this and the
      // direct kill below run: the group call fails on a child that never
      // became leader, and succeeds without touching a child that is not in it.
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone, or the child never led one.
    }
  }

  invokeKill(killDirectChild);
}

function invokeKill(killDirectChild: () => void): void {
  try {
    killDirectChild();
  } catch {
    // The process already exited; nothing is left to signal.
  }
}

/**
 * SIGKILL every group member except the leader, then the leader once it has
 * had a chance to reap. Returns false when `/proc` cannot be read, so the
 * caller can fall back to signalling the group as a unit.
 */
function killLinuxProcessTree(leaderPid: number, killDirectChild: () => void): boolean {
  // A command can spawn a new child after the first sweep (`sleep 60;
  // sleep 60 & wait`). Each tick re-lists and signals whatever is there now,
  // and the leader is only taken down once the group is just it, or the
  // budget runs out. `null` is an unreadable `/proc`, which the first sweep
  // reports to the caller so it can signal the group as a unit instead.
  const sweep = (): boolean | null => {
    const current = linuxProcessGroupMembers(leaderPid);
    if (current === null) return null;
    let remaining = false;
    for (const pid of current) {
      if (pid === leaderPid || pid <= 1) continue;
      remaining = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    return remaining;
  };

  const first = sweep();
  if (first === null) return false;
  if (!first) {
    invokeKill(killDirectChild);
    return true;
  }

  const deadline = Date.now() + LEADER_REAP_BUDGET_MS;
  const tick = () => {
    // `!== true` covers a `/proc` that became unreadable mid-reap: nothing more
    // can be observed, so the leader goes now rather than at the deadline.
    if (sweep() !== true || Date.now() >= deadline) {
      invokeKill(killDirectChild);
      return;
    }
    const next = setTimeout(tick, LEADER_REAP_POLL_MS);
    next.unref?.();
  };
  const timer = setTimeout(tick, LEADER_REAP_POLL_MS);
  timer.unref?.();
  return true;
}

/**
 * PIDs whose process-group id is `pgid`, or `null` when `/proc` is unreadable.
 * Zombies are included: they still occupy a table slot until the leader waitpids.
 */
function linuxProcessGroupMembers(pgid: number): number[] | null {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }

  const members: number[] = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) continue;
      const fields = stat.slice(closeParen + 2).split(' ');
      // After `pid (comm)`: state, ppid, pgrp.
      if (Number(fields[2]) === pgid) members.push(pid);
    } catch {
      // Vanished between readdir and read.
    }
  }
  return members;
}

/**
 * Starts `taskkill /T /F` without waiting, and only kills the direct child if
 * that spawn fails. Killing the root first is what hides the descendants from
 * `/T`. `spawnTaskkill` is the production `spawn` and a test fake.
 */
export function startWindowsTaskkillTree(
  pid: number,
  killDirectChild: () => void,
  spawnTaskkill: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: 'ignore'; readonly windowsHide: boolean }
  ) => {
    once(event: 'error' | 'close', listener: (codeOrError?: unknown) => void): unknown;
    unref(): unknown;
  } = spawn
): void {
  const fallback = () => invokeKill(killDirectChild);
  try {
    const taskkill = spawnTaskkill('taskkill', [...windowsTaskkillArguments(pid)], {
      stdio: 'ignore',
      ...HIDDEN_WINDOW,
    });
    // Nothing awaits this child, so its failure must not surface as an
    // unhandled error event on the process. An error or a non-zero exit is
    // the same fallback the awaited Windows teardown uses: the direct child
    // only, with no claim on descendants.
    taskkill.once('error', fallback);
    taskkill.once('close', (code) => {
      if (code !== 0) fallback();
    });
    taskkill.unref();
  } catch {
    fallback();
  }
}
