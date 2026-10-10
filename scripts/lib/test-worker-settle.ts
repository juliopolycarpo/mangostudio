// What a test worker leaves behind. A lane whose tests spawn the real runtime,
// servers and `sh` children has to prove, once its worker has exited, that none
// of them is still running: a leaked process holds a port or a lock for the next
// run and, with workers side by side, for the sibling that started beside it.
//
// A worker that settles leads a process group of its own (see
// ./test-worker-process.ts), so everything it started and did not move out of
// that group is a member of the group. Where /proc exists the check also looks
// for the per-worker token in a process's environment, which finds a descendant
// that started its own session but still carries the worker's environment.
// A descendant that does both (a new session and a scrubbed environment) is not
// found; nothing here pretends it would be.
//
// Imports nothing from the repository: this file is named in the Turbo inputs
// of the cached `test:unit` task, next to the runner that loads it.

import { readdirSync, readFileSync } from 'node:fs';

/** Set, to a value unique to one worker, in that worker's environment. */
export const WORKER_TOKEN_ENV = 'MANGO_TEST_WORKER_TOKEN';

/** How long a worker's descendants get to exit after the worker has, before one counts as left behind. */
const SETTLE_GRACE_MS = 2_000;

/** A process that outlived its worker. */
export interface Leftover {
  readonly pid: number;
  readonly command: string;
}

/** One row of the process table, as much of it as the check reads. */
export interface ProcessEntry {
  readonly pid: number;
  readonly pgid: number;
  /** The first letter of the state; `Z` is a zombie, which holds nothing but a table slot. */
  readonly state: string;
  readonly command: string;
  /** The environment as `KEY=value` lines, where it could be read. */
  readonly environ?: string;
}

/** Reads the process table; the real one is {@link systemProcessTable}. */
export type ProcessTable = () => readonly ProcessEntry[];

export interface WorkerIdentity {
  /** The group the worker leads, or null when it does not lead one. */
  readonly pgid: number | null;
  readonly token: string;
}

/**
 * The processes of `entries` that belong to the worker: in its group, or
 * carrying its token. A zombie is not left behind, only unreaped.
 *
 * @example
 * findLeftovers(entries, { pgid: 4242, token: 'w1' }); // => [{ pid: 4300, command: 'sleep 600' }]
 */
export function findLeftovers(
  entries: readonly ProcessEntry[],
  who: WorkerIdentity
): readonly Leftover[] {
  const marker = `${WORKER_TOKEN_ENV}=${who.token}`;
  return entries
    .filter((entry) => entry.state !== 'Z')
    .filter(
      (entry) =>
        (who.pgid !== null && entry.pgid === who.pgid) ||
        (entry.environ?.split('\n').includes(marker) ?? false)
    )
    .map(({ pid, command }) => ({ pid, command }));
}

function linuxTable(): ProcessEntry[] | undefined {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return undefined;
  }
  const entries: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses.
      const [state, , pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let command = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      if (!command) command = `[${stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))}]`;
      let environ: string | undefined;
      try {
        environ = readFileSync(`/proc/${name}/environ`, 'utf8').replaceAll('\0', '\n');
      } catch {
        // Not ours to read, or already gone: the group check still applies.
      }
      entries.push({
        pid: Number(name),
        pgid: Number(pgid),
        state: (state ?? '?').slice(0, 1),
        command,
        environ,
      });
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return entries;
}

function psTable(): ProcessEntry[] {
  const ps = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=,pgid=,stat=,command='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (ps.exitCode !== 0) {
    throw new Error(
      `test workers: expected ps to list the process table | received: exit ${ps.exitCode}: ${ps.stderr.toString().trim()}`
    );
  }
  return ps.stdout
    .toString()
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) return [];
      return [
        {
          pid: Number(match[1]),
          pgid: Number(match[2]),
          state: (match[3] ?? '?').slice(0, 1),
          command: match[4] ?? '',
        },
      ];
    });
}

/**
 * The machine's process table: /proc where there is one, `ps` otherwise.
 *
 * @example
 * findLeftovers(systemProcessTable(), { pgid: child.pid, token });
 */
const systemProcessTable: ProcessTable = () => linuxTable() ?? psTable();

export interface SignalWorkerOptions {
  readonly table?: ProcessTable;
  readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Signals the worker's group and token-bearing children that left it. A group
 * member receives the group signal once; other workers and zombies are ignored.
 * Detached children must receive cancellation before output draining can hold
 * the runner past its outer supervisor's deadline. An empty token signals only
 * the group; the lane still rejects a worker without a settlement guard.
 *
 * @example
 * signalWorker({ pgid: child.pid, token }, 'SIGKILL');
 */
export function signalWorker(
  who: WorkerIdentity,
  signal: NodeJS.Signals,
  options: SignalWorkerOptions = {}
): void {
  const { table = systemProcessTable, sendSignal = process.kill } = options;
  if (who.pgid !== null) {
    try {
      sendSignal(-who.pgid, signal);
    } catch {
      // The group emptied between the decision and the signal.
    }
  }
  if (!who.token) return;
  const escaped = table().filter((entry) => entry.pgid !== who.pgid);
  for (const { pid } of findLeftovers(escaped, { pgid: null, token: who.token })) {
    try {
      sendSignal(pid, signal);
    } catch {
      // The child exited between the table read and the signal.
    }
  }
}

export interface SettleOptions {
  readonly who: WorkerIdentity;
  readonly table?: ProcessTable;
  readonly graceMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called with what is still running once the grace is over; the real one SIGKILLs it. */
  readonly reap?: (leftovers: readonly Leftover[], who: WorkerIdentity) => void;
}

/** SIGKILLs the worker's group and every process found by token. */
function reapLeftovers(leftovers: readonly Leftover[], who: WorkerIdentity): void {
  if (who.pgid !== null) {
    try {
      process.kill(-who.pgid, 'SIGKILL');
    } catch {
      // The group emptied between the check and the signal.
    }
  }
  for (const { pid } of leftovers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Waits up to `graceMs` for the worker's descendants to be gone and returns what
 * is still running, after killing it so a failed lane does not leave it behind.
 * An empty list is a worker that settled.
 *
 * @example
 * const leftovers = await settleWorker({ who: { pgid: child.pid, token } });
 */
export async function settleWorker(options: SettleOptions): Promise<readonly Leftover[]> {
  const {
    who,
    table = systemProcessTable,
    graceMs = SETTLE_GRACE_MS,
    pollMs = 50,
    sleep = (ms) => Bun.sleep(ms),
    reap = reapLeftovers,
  } = options;

  let waited = 0;
  let leftovers = findLeftovers(table(), who);
  while (leftovers.length > 0 && waited < graceMs) {
    await sleep(pollMs);
    waited += pollMs;
    leftovers = findLeftovers(table(), who);
  }
  if (leftovers.length > 0) reap(leftovers, who);
  return leftovers;
}
