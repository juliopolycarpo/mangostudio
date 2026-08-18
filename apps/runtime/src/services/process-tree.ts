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
 * How many `/proc/<pid>/stat` reads are in flight at once during a sweep.
 *
 * The reads are independent, so awaiting them one at a time is an order of
 * magnitude slower in wall time — measured over 1600 `/proc` reads, 437ms
 * sequential against 21ms batched at this width — and the reap budget below is
 * written against a sweep costing tens of milliseconds, so a serialised sweep
 * spends the whole budget before the first re-sweep ever runs. Batching
 * keeps the walk off the event loop just as well: the loop is free between
 * batches, which is all the yielding was ever for.
 */
const PROC_READ_CONCURRENCY = 64;

/**
 * The narrow slice of `node:fs/promises` the Linux tree walk needs. Its own
 * type rather than `typeof readdir` / `typeof readFile` so a test fake only
 * has to implement the one call shape actually used, not every overload.
 *
 * Passed as one object rather than positional parameters, matching the seam
 * shape the neighbouring services use (`ShellExecDependencies` in `shell.ts`),
 * so a further seam does not have to be threaded through three call frames.
 */
export interface ProcWalkDependencies {
  readonly readdir: (path: string) => Promise<string[]>;
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
}

const defaultProcWalk: ProcWalkDependencies = { readdir, readFile };

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

  if (pid === undefined || pid <= 1) {
    invokeKill(killDirectChild);
    return;
  }

  // Linux takes the group down a member at a time so the leader can waitpid
  // them. It declines when `/proc` is unreadable, and then the group signal is
  // the fallback — the same one every other POSIX platform takes. The walk is
  // async (readdir/readFile land on the event loop rather than blocking it), so
  // it cannot report its outcome synchronously here; it runs the fallback and
  // the direct-child kill itself once it knows.
  if (process.platform === 'linux') {
    void attemptLinuxProcessTreeKill(pid, killDirectChild);
    return;
  }
  posixGroupKill(pid, killDirectChild);
}

/** Signals the group the child leads as a unit, then the child itself. */
function posixGroupKill(pid: number, killDirectChild: () => void): void {
  try {
    // Negative PID addresses the group the child leads. Both this and the
    // direct kill below run: the group call fails on a child that never
    // became leader, and succeeds without touching a child that is not in it.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone, or the child never led one.
  }
  invokeKill(killDirectChild);
}

/**
 * Fire-and-forget bridge to {@link killLinuxProcessTree}: takes the POSIX
 * fallback itself when `/proc` turned out to be unreadable, since the async
 * walk cannot report that back to {@link killProcessTree} in time.
 */
async function attemptLinuxProcessTreeKill(
  leaderPid: number,
  killDirectChild: () => void
): Promise<void> {
  try {
    if (await killLinuxProcessTree(leaderPid, killDirectChild)) return;
  } catch {
    // Every read and kill inside the walk already swallows its own errors;
    // this is only a last-resort net so the direct child is not left running
    // if something outside that still throws.
    invokeKill(killDirectChild);
    return;
  }
  posixGroupKill(leaderPid, killDirectChild);
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
 * `deps` is the production `node:fs/promises` pair and a test seam — a walk
 * over a large `/proc` is exactly the cost this rewrite exists to move off the
 * event loop, so a test has to be able to make the walk itself slow without a
 * real filesystem that size.
 */
export async function killLinuxProcessTree(
  leaderPid: number,
  killDirectChild: () => void,
  deps: ProcWalkDependencies = defaultProcWalk
): Promise<boolean> {
  // A command can spawn a new child after the first sweep (`sleep 60;
  // sleep 60 & wait`). Each tick re-lists and signals whatever is there now,
  // and the leader is only taken down once nothing else remains, or the
  // budget runs out. `null` is an unreadable `/proc`, which the first sweep
  // reports to the caller so it can signal the group as a unit instead.
  const sweep = async (): Promise<boolean | null> => {
    const current = await linuxTreeTargets(leaderPid, deps);
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

  // Budgets the reap polling only. The first sweep is the one that does the
  // killing and has to finish whatever it costs; starting the clock before it
  // would let a slow sweep consume the budget and skip the re-sweeps entirely.
  const deadline = Date.now() + LEADER_REAP_BUDGET_MS;
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
  deps: ProcWalkDependencies = defaultProcWalk
): Promise<number[] | null> {
  const rows = await readLinuxProcRows(deps);
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
 * Async so the walk is a sequence of yield points: a sweep against a host with
 * thousands of processes lets timers and other tool calls run between batches
 * rather than holding the loop for the whole walk. The reads within a batch are
 * independent and go out together — awaiting them one at a time would be an
 * order of magnitude slower in wall time while yielding no more usefully.
 *
 * Always reads every entry. The point this rewrite fixes is what a walk costs
 * the loop while it runs, not how long the walk itself takes, and a walk that
 * gave up partway through could give up before it ever reached the one entry it
 * was looking for — leaving that process unsignalled rather than signalled late.
 */
async function readLinuxProcRows(deps: ProcWalkDependencies): Promise<LinuxProcRow[] | null> {
  let names: string[];
  try {
    names = await deps.readdir('/proc');
  } catch {
    return null;
  }

  const pids = names.filter((name) => /^[0-9]+$/.test(name)).map(Number);
  const rows: LinuxProcRow[] = [];
  for (let start = 0; start < pids.length; start += PROC_READ_CONCURRENCY) {
    const batch = await Promise.all(
      pids.slice(start, start + PROC_READ_CONCURRENCY).map((pid) => readLinuxProcRow(pid, deps))
    );
    for (const row of batch) {
      if (row) rows.push(row);
    }
  }
  return rows;
}

/** Parses one `/proc/<pid>/stat`, or `null` if it cannot be read or parsed. */
async function readLinuxProcRow(
  pid: number,
  deps: ProcWalkDependencies
): Promise<LinuxProcRow | null> {
  let stat: string;
  try {
    stat = await deps.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    // Vanished between readdir and read.
    return null;
  }
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = stat.slice(closeParen + 2).split(' ');
  // After `pid (comm)`: state, ppid, pgrp.
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) return null;
  return { pid, ppid, pgid };
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
