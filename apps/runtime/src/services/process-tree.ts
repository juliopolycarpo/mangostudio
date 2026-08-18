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
import { readdir, readFile } from 'node:fs/promises';
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

/**
 * The narrow slice of `node:fs/promises` the Linux tree walk needs. Its own
 * type rather than `typeof readdir` / `typeof readFile` so a test fake only
 * has to implement the one call shape actually used, not every overload.
 */
type ReadDirFn = (path: string) => Promise<string[]>;
type ReadFileFn = (path: string, encoding: 'utf8') => Promise<string>;

/**
 * How long a fire-and-forget `taskkill` may run before the direct child is
 * killed instead. Matches the awaited Windows teardown in
 * `external-agents/process.ts`. Unref'd: the caller is already waiting on the
 * child it owns, and this timer must not keep the runtime alive by itself.
 */
const WINDOWS_TASKKILL_FALLBACK_MS = 2_000;

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
 * On Linux the group members and any descendant that left the group are
 * signalled first, and the leader a moment later. A single `kill(-pid, SIGKILL)`
 * races the leader with its children, so the leader never waitpids them and
 * they land on PID 1 as zombies. Docker images in this repo run the hub as
 * PID 1, which does not reap adopted children.
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
    // The walk is async (readdir/readFile land on the event loop rather than
    // blocking it), so it cannot report its outcome synchronously here; it
    // runs the same fallback and the direct-child kill itself once it knows.
    if (process.platform === 'linux') {
      void attemptLinuxProcessTreeKill(pid, killDirectChild);
      return;
    }
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

/**
 * Fire-and-forget wrapper around {@link killLinuxProcessTree}: runs the async
 * walk, then either it already invoked the direct-child kill (a normal or
 * empty sweep) or `/proc` was unreadable and the group-signal fallback plus
 * the direct kill still have to run — the same fallback every other POSIX
 * platform takes in {@link killProcessTree}.
 */
async function attemptLinuxProcessTreeKill(
  leaderPid: number,
  killDirectChild: () => void
): Promise<void> {
  try {
    const handled = await killLinuxProcessTree(leaderPid, killDirectChild);
    if (handled) return;
    try {
      process.kill(-leaderPid, 'SIGKILL');
    } catch {
      // The group is already gone, or the leader never led one.
    }
    invokeKill(killDirectChild);
  } catch {
    // Every read and kill inside the walk already swallows its own errors;
    // this is only a last-resort net so the direct child is not left running
    // if something outside that still throws.
    invokeKill(killDirectChild);
  }
}

function invokeKill(killDirectChild: () => void): void {
  try {
    killDirectChild();
  } catch {
    // The process already exited; nothing is left to signal.
  }
}

/**
 * SIGKILL every group member and every descendant that left the group, then
 * the leader once it has had a chance to reap. Returns false when `/proc`
 * cannot be read, so the caller can fall back to signalling the group as a
 * unit. Already fire-and-forget from the caller's side ({@link
 * attemptLinuxProcessTreeKill} does not await it either), so awaiting the
 * poll loop out here keeps the shape simple without blocking anything.
 *
 * `readdirFn`/`readFileFn` are the production `node:fs/promises` functions
 * and a test seam — a synchronous walk over a large `/proc` is exactly the
 * cost this rewrite exists to move off the event loop, so a test has to be
 * able to make the walk itself slow without a real filesystem that size.
 */
export async function killLinuxProcessTree(
  leaderPid: number,
  killDirectChild: () => void,
  readdirFn: ReadDirFn = readdir,
  readFileFn: ReadFileFn = readFile
): Promise<boolean> {
  const deadline = Date.now() + LEADER_REAP_BUDGET_MS;

  // A command can spawn a new child after the first sweep (`sleep 60;
  // sleep 60 & wait`). Each tick re-lists and signals whatever is there now,
  // and the leader is only taken down once nothing else remains, or the
  // budget runs out. `null` is an unreadable `/proc`, which the first sweep
  // reports to the caller so it can signal the group as a unit instead.
  //
  // Each sweep always reads every `/proc` entry to completion — cutting a
  // sweep short partway through the listing would mean never having read the
  // one entry that was the actual target, silently leaving it unsignalled
  // rather than merely signalling it late. The budget bounds how many sweeps
  // run, exactly as it did synchronously; it does not truncate one.
  const sweep = async (): Promise<boolean | null> => {
    const current = await linuxTreeTargets(leaderPid, readdirFn, readFileFn);
    if (current === null) return null;
    let remaining = false;
    for (const pid of current) {
      remaining = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    return remaining;
  };

  const first = await sweep();
  if (first === null) return false;
  if (!first) {
    invokeKill(killDirectChild);
    return true;
  }

  while (Date.now() < deadline) {
    await sleep(LEADER_REAP_POLL_MS);
    // `!== true` covers a `/proc` that became unreadable mid-reap: nothing
    // more can be observed, so the leader goes now rather than waiting out
    // the rest of the budget.
    if ((await sweep()) !== true) break;
  }
  invokeKill(killDirectChild);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * PIDs to signal before the leader, or `null` when `/proc` is unreadable.
 *
 * Union of the leader's process-group members and its descendants by parentage.
 * Group membership is the cheap bulk path; parentage catches a child that
 * called `setsid` or `setpgid` and left the group while the leader is still
 * alive. Zombies are included: they still occupy a table slot until waitpid.
 *
 * A descendant that double-forks and is reparented to PID 1 is gone from both
 * views. A cgroup around the call would cover that; this scan does not.
 */
export async function linuxTreeTargets(
  leaderPid: number,
  readdirFn: ReadDirFn,
  readFileFn: ReadFileFn
): Promise<number[] | null> {
  const rows = await readLinuxProcRows(readdirFn, readFileFn);
  if (rows === null) return null;

  const children = new Map<number, number[]>();
  const targets = new Set<number>();
  for (const row of rows) {
    if (row.pid <= 1) continue;
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
    if (row.pid !== leaderPid && row.pgid === leaderPid) targets.add(row.pid);
  }

  const stack = [...(children.get(leaderPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (
      pid === undefined ||
      pid <= 1 ||
      pid === leaderPid ||
      pid === process.pid ||
      seen.has(pid)
    ) {
      continue;
    }
    seen.add(pid);
    targets.add(pid);
    const kids = children.get(pid);
    if (kids) stack.push(...kids);
  }

  return [...targets];
}

interface LinuxProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/**
 * There is no cheaper Linux membership primitive than this for an arbitrary
 * process group: `/proc` has no index from a `pgid` to its members, only from
 * a `pid` to its own `stat`. A cgroup placed around the spawn would give one,
 * but that is a call the spawn site would have to make, not this reaper — so
 * the full walk is kept deliberately and moved off the event loop instead.
 *
 * Async so each read is a yield point: a sweep against a host with thousands
 * of processes lets timers and other tool calls run between reads rather than
 * holding the loop for the whole walk. Always reads every entry — the point
 * this rewrite fixes is what a walk costs the loop while it runs, not how
 * long the walk itself takes, and a walk that gives up partway through could
 * give up before it ever reached the one entry it was looking for.
 */
async function readLinuxProcRows(
  readdirFn: ReadDirFn,
  readFileFn: ReadFileFn
): Promise<LinuxProcRow[] | null> {
  let names: string[];
  try {
    names = await readdirFn('/proc');
  } catch {
    return null;
  }

  const rows: LinuxProcRow[] = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = await readFileFn(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) continue;
      const fields = stat.slice(closeParen + 2).split(' ');
      // After `pid (comm)`: state, ppid, pgrp.
      const ppid = Number(fields[1]);
      const pgid = Number(fields[2]);
      if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue;
      rows.push({ pid, ppid, pgid });
    } catch {
      // Vanished between readdir and read.
    }
  }
  return rows;
}

/**
 * Starts `taskkill /T /F` without waiting, and only kills the direct child if
 * that spawn fails, exits non-zero, or has not settled by `fallbackMs`.
 * Killing the root first is what hides the descendants from `/T`, so the
 * deadline is the bound that still lets `/T` walk before we give up.
 * `spawnTaskkill` is the production `spawn` and a test fake.
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
    kill?(): unknown;
  } = spawn,
  fallbackMs: number = WINDOWS_TASKKILL_FALLBACK_MS
): void {
  let settled = false;
  const fallback = () => {
    if (settled) return;
    settled = true;
    invokeKill(killDirectChild);
  };
  try {
    const taskkill = spawnTaskkill('taskkill', [...windowsTaskkillArguments(pid)], {
      stdio: 'ignore',
      ...HIDDEN_WINDOW,
    });
    // Nothing awaits this child, so its failure must not surface as an
    // unhandled error event on the process. An error, a non-zero exit, or a
    // hung taskkill is the same fallback the awaited Windows teardown uses:
    // the direct child only, with no claim on descendants. A hung taskkill
    // is killed too: `/T /F` against a PID that has since been reused would
    // hit whatever inherited that number.
    const timer = setTimeout(
      () => {
        try {
          taskkill.kill?.();
        } catch {
          // Already gone.
        }
        fallback();
      },
      Math.max(0, fallbackMs)
    );
    timer.unref?.();
    const done = (failed: boolean) => {
      clearTimeout(timer);
      if (failed) fallback();
      else settled = true;
    };
    taskkill.once('error', () => done(true));
    taskkill.once('close', (code) => done(code !== 0));
    taskkill.unref();
  } catch {
    fallback();
  }
}
