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
export const SETTLE_GRACE_MS = 2_000;

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
  /** The session id, where the table has one. */
  readonly sid?: number;
  /** When the process started, in the table's own unit (clock ticks since boot on Linux). */
  readonly startedAt?: string;
}

/** Reads the process table; the real one is {@link systemProcessTable}. */
export type ProcessTable = () => readonly ProcessEntry[];

export interface WorkerIdentity {
  /** The group the worker leads, or null when it does not lead one. */
  readonly pgid: number | null;
  readonly token: string;
}

/**
 * The command line of podman's rootless pause process. The first rootless
 * `podman` call of a user starts it, and it is meant to outlive that call: it
 * keeps the user namespace alive for the containers that follow. It inherits the
 * environment, and so the token, of whichever worker ran that first call, but it
 * is per-user state, not something the worker leaked. It is neither reported nor
 * signalled. The match is exact: the whole command line, nothing else.
 */
export const PODMAN_PAUSE_COMMAND = 'catatonit -P';

/**
 * The processes of `entries` that belong to the worker: in its group, or
 * carrying its token. A zombie is not left behind, only unreaped, and podman's
 * pause process ({@link PODMAN_PAUSE_COMMAND}) is not the worker's.
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
    .filter((entry) => entry.command !== PODMAN_PAUSE_COMMAND)
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
      const [state, , pgid, session, , , , , , , , , , , , , , , , startedAt] = stat
        .slice(stat.lastIndexOf(')') + 2)
        .split(' ');
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
        sid: Number(session),
        startedAt,
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

/** Refuses a worker pid that is no usable group id; see {@link killProcessGroup}. */
function assertGroupId(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(
      `test workers: expected worker pid: integer > 1 | received: ${JSON.stringify(pgid)}`
    );
  }
}

/**
 * Sends `signal` to the process group `pgid`, and to no other. A group id of 0 or
 * 1, or one that is not an integer, would be sent as `-0` (the caller's own
 * group, so the runner and `bun run` with it), `-1` (every process the user
 * owns), or `NaN` from an empty string: all of them refused with an error that
 * names the value. A group that has already emptied is not an error.
 *
 * @example
 * killProcessGroup(child.pid, 'SIGKILL');
 */
export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = process.kill
): void {
  assertGroupId(pgid);
  try {
    sendSignal(-pgid, signal);
  } catch {
    // The group emptied between the decision and the signal.
  }
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
  if (who.pgid !== null) killProcessGroup(who.pgid, signal, sendSignal);
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

/** SIGKILLs what is left of the worker through {@link sweepWorker}; its notes were printed when the worker exited. */
function reapLeftovers(_leftovers: readonly Leftover[], who: WorkerIdentity): void {
  sweepWorker(who, { label: 'reap' });
}

/** The value of `key` in an environment of `KEY=value` lines, or `unset`. */
function environmentValue(environ: string | undefined, key: string): string {
  const line = environ?.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  return line === undefined ? 'unset' : line.slice(key.length + 1);
}

/**
 * One line naming a podman pause process the leftover check ignored, so a run
 * can say what started it. It carries the process's identity and only two of its
 * environment variables (`PWD`, `_`): the environment as a whole holds tokens.
 * It says whether the process shares the worker's group or session, which
 * decides whether a group SIGKILL may be sent (see {@link sweepWorker}).
 */
function describePauseProcess(
  pauser: ProcessEntry,
  who: WorkerIdentity,
  label: string,
  groupKillSkipped: boolean
): string {
  const sharesGroup = who.pgid !== null && pauser.pgid === who.pgid;
  const sharesSession = who.pgid !== null && pauser.sid === who.pgid;
  return (
    `${label}: ignored podman pause process (${PODMAN_PAUSE_COMMAND}), not a leftover | ` +
    `pid ${pauser.pid} pgid ${pauser.pgid} sid ${pauser.sid ?? 'unknown'} ` +
    `started ${pauser.startedAt ?? 'unknown'} PWD=${environmentValue(pauser.environ, 'PWD')} ` +
    `_=${environmentValue(pauser.environ, '_')} | shares worker group: ${sharesGroup}, ` +
    `session: ${sharesSession}${groupKillSkipped ? ' | group SIGKILL skipped, members killed by pid' : ''}`
  );
}

/** The podman pause processes among `rows` that belong to the worker's group or carry its token. */
function pausersOf(rows: readonly ProcessEntry[], who: WorkerIdentity): readonly ProcessEntry[] {
  const marker = `${WORKER_TOKEN_ENV}=${who.token}`;
  return rows.filter(
    (row) =>
      row.command === PODMAN_PAUSE_COMMAND &&
      ((who.pgid !== null && row.pgid === who.pgid) ||
        (row.environ?.split('\n').includes(marker) ?? false))
  );
}

/**
 * The notes for the podman pause processes of the worker, without signalling
 * anything: what a settling worker prints when it exits, before `settle` waits.
 *
 * @example
 * noteWorkerPausers({ pgid: child.pid, token }, { label: 'api-integration worker 2/2' });
 */
export function noteWorkerPausers(
  who: WorkerIdentity,
  options: { readonly table?: ProcessTable; readonly label: string }
): readonly string[] {
  const { table = systemProcessTable, label } = options;
  const rows = table().filter((row) => row.state !== 'Z');
  return pausersOf(rows, who).map((pauser) => describePauseProcess(pauser, who, label, false));
}

export interface SweepOptions {
  readonly table?: ProcessTable;
  readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Names the worker in the notes, for example `api-integration worker 2/2`. */
  readonly label: string;
}

/**
 * The end-of-worker kill: SIGKILLs what the worker left in its group and what
 * carries its token elsewhere, and returns one note per thing worth saying.
 *
 * The group id of a worker that has been reaped is free for any process to take,
 * and a later group leader (another lane's worker, a shell job) would take the
 * signal. So the group is signalled only when the process table shows a live
 * process in it that carries this worker's token; a group held only by
 * processes without the token is left alone and noted, and an empty group gets
 * no signal. Where the table has no environments at all (`ps`), or the caller
 * has no token to give, the group alone decides.
 *
 * A podman pause process in the group would die with a group signal, and it is
 * the user's rootless state, not the worker's. Then no group signal is sent:
 * each remaining token-carrying member is killed by pid instead.
 *
 * @example
 * for (const note of sweepWorker({ pgid: child.pid, token }, { label: 'root worker 1/2' })) log(note);
 */
export function sweepWorker(who: WorkerIdentity, options: SweepOptions): readonly string[] {
  const { table = systemProcessTable, sendSignal = process.kill, label } = options;
  if (who.pgid !== null) assertGroupId(who.pgid);
  const rows = table().filter((row) => row.state !== 'Z');
  const marker = `${WORKER_TOKEN_ENV}=${who.token}`;
  const carriesToken = (row: ProcessEntry): boolean =>
    who.token !== '' && (row.environ?.split('\n').includes(marker) ?? false);
  const tableReadsEnvironments = rows.some((row) => row.environ !== undefined);
  const inGroup = who.pgid === null ? [] : rows.filter((row) => row.pgid === who.pgid);
  // A caller with no token (the fixture command runner) has only the group to go by.
  const groupAloneDecides = who.token === '' || !tableReadsEnvironments;
  const owned = inGroup.filter((row) => carriesToken(row) || groupAloneDecides);
  const pausers = pausersOf(rows, who);
  const pauseInGroup = inGroup.some((row) => row.command === PODMAN_PAUSE_COMMAND);
  const groupKill = who.pgid !== null && owned.length > 0 && !pauseInGroup;

  const notes: string[] = [];
  for (const pauser of pausers) {
    notes.push(describePauseProcess(pauser, who, label, pauseInGroup && pauser.pgid === who.pgid));
  }
  if (who.pgid !== null && inGroup.length > 0 && owned.length === 0) {
    notes.push(
      `${label}: group ${who.pgid} is held by ${inGroup.length} process(es) without the worker's token ` +
        `(${inGroup.map((row) => `pid ${row.pid}`).join(', ')}); nothing signalled`
    );
  }
  if (groupKill && who.pgid !== null) killProcessGroup(who.pgid, 'SIGKILL', sendSignal);

  // Token carriers outside a signalled group, or every one when the group was spared.
  const byPid = rows.filter(
    (row) =>
      carriesToken(row) &&
      row.command !== PODMAN_PAUSE_COMMAND &&
      !(groupKill && row.pgid === who.pgid)
  );
  for (const { pid } of byPid) {
    try {
      sendSignal(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return notes;
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
