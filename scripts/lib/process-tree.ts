// Child supervision for the script runners: how many children a runner may have
// live at once, and what happens to them when the runner is cancelled.
//
// POSIX. A root runner starts each child in its own process group, so one
// signal to `-pid` reaches everything that child started, grandchildren
// included, however deep. Moving a child out of the terminal's foreground group
// means the kernel no longer delivers Ctrl-C to it, so the runner catches
// SIGINT, SIGTERM and SIGHUP and forwards each to every child group exactly
// once. After a grace period it SIGKILLs what is left, then exits with the
// conventional 128 + signal status. A runner that is itself a child of another
// runner (`MANGO_RUNNER_GROUP` is set) leaves its children in the group it was
// given, so the one group signal from above is the only one they ever see.
//
// Not covered: SIGKILL of the runner itself. It cannot be caught, and the
// children it already moved to their own groups outlive it.
//
// Windows has no process groups to signal, so the runner puts itself in a job
// object that kills every member when the runner ends, by Ctrl-C, `taskkill /F`
// or a crash alike. Bun already gives a runner's direct children a job of their
// own, but that job lets their children break away, so a chain that passes
// through cmd.exe (every `.cmd` shim: bunx, turbo, tsc) outlives the runner.
// `detached: true` leaves the job, so nothing here uses it on Windows, and
// nothing installs a signal handler there.

import { constants } from 'node:os';

import { error } from './log';

/** The signals that cancel a runner. SIGKILL is not catchable and so not listed. */
export type CancelSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

const CANCEL_SIGNALS: readonly CancelSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Set in the environment of a child that leads a group a runner owns. A runner
 * that finds it set is nested: the group signal it receives already reaches its
 * own children, so it neither regroups them nor forwards.
 */
export const RUNNER_GROUP_ENV = 'MANGO_RUNNER_GROUP';

/** Overrides {@link DEFAULT_CHILD_LIMIT} for every runner process that inherits it. */
export const CHILD_LIMIT_ENV = 'MANGO_RUNNER_CONCURRENCY';

/**
 * Children one runner process may have live at once, shared by every nested
 * `runParallel` / `mapWithConcurrency` call inside it. The widest fan-out in use
 * is `bun run protocol:check` with 12 tasks (13 with the powerset split); a
 * `bun run check` peaks at 11 children in the root runner and 16 live processes
 * across it and its nested protocol runner. 16 therefore never delays today's
 * runs and still stops accidental nesting from multiplying the process count.
 */
export const DEFAULT_CHILD_LIMIT = 16;

/** How long a cancelled child gets to exit on its own before it is SIGKILLed. */
export const CANCEL_GRACE_MS = 5_000;

/** How long to wait for SIGKILLed children before giving up and exiting anyway. */
const KILL_WAIT_MS = 2_000;

/** Win32 job object limit flag and information class, from winnt.h. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;

/** A second signal this soon after the first is the same keypress, not impatience. */
const REPEAT_WINDOW_MS = 1_000;

/**
 * The child limit a runner process runs under.
 *
 * @example
 * childLimit({ MANGO_RUNNER_CONCURRENCY: '4' }); // 4
 */
export function childLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env[CHILD_LIMIT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_CHILD_LIMIT;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${CHILD_LIMIT_ENV}: ${raw} | expected a positive integer`);
  }
  return parsed;
}

/** True when a runner above this process already owns the group it runs in. */
function isNestedRunner(env: Record<string, string | undefined>): boolean {
  const owner = env[RUNNER_GROUP_ENV];
  return owner !== undefined && owner !== '';
}

/**
 * How a runner supervises one child it is about to spawn.
 *
 * - `group`: the child leads its own process group and the runner signals it.
 * - `direct`: an interactive child (stdin inherited) stays in the terminal's
 *   foreground group, because a child outside it cannot read the terminal; the
 *   runner can only signal that one pid.
 * - `none`: Windows, which has no groups and relies on the job object, and a
 *   nested runner, whose children already share the group the runner above owns.
 *
 * @example
 * supervisionMode('ignore', 'linux', {}); // 'group'
 */
export function supervisionMode(
  stdin: 'inherit' | 'ignore' | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): 'group' | 'direct' | 'none' {
  if (platform === 'win32' || isNestedRunner(env)) return 'none';
  return stdin === 'inherit' ? 'direct' : 'group';
}

/**
 * The status a runner exits with after a signal cancelled it, as a shell would
 * report a process that died of it.
 *
 * @example
 * cancelExitStatus('SIGTERM'); // 143
 */
export function cancelExitStatus(signal: CancelSignal): number {
  return 128 + constants.signals[signal];
}

let descendantsBound: Promise<void> | undefined;

/**
 * Windows only; resolves at once elsewhere. Puts this process into a job object
 * that terminates every member when its handle closes, and this process holds
 * the only handle, so whatever it started (at any depth, through cmd.exe or
 * not) ends when it does. Best effort: where the job cannot be created, say so
 * once and carry on as before.
 *
 * @example
 * await bindDescendantsToRunner();
 */
export function bindDescendantsToRunner(
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'win32') return Promise.resolve();
  descendantsBound ??= createKillOnCloseJob().catch((caught: unknown) => {
    const reason = caught instanceof Error ? caught.message : String(caught);
    error(`runner: no job object (${reason}); children may outlive this process if it is killed`);
  });
  return descendantsBound;
}

async function createKillOnCloseJob(): Promise<void> {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const kernel32 = dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const { symbols } = kernel32;

  // No security attributes, so the handle is not inheritable: no child can keep
  // the job open past this process. The handle is never closed; it lives until
  // this process ends, which is the moment the job is meant to fire.
  const job = symbols.CreateJobObjectW(null, null);
  if (!job) throw new Error(`CreateJobObjectW failed with error ${symbols.GetLastError()}`);

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows, and
  // LimitFlags sits after the two 8-byte time limits.
  const info = new Uint8Array(144);
  new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (
    !symbols.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      ptr(info),
      info.byteLength
    )
  ) {
    throw new Error(`SetInformationJobObject failed with error ${symbols.GetLastError()}`);
  }
  if (!symbols.AssignProcessToJobObject(job, symbols.GetCurrentProcess())) {
    throw new Error(`AssignProcessToJobObject failed with error ${symbols.GetLastError()}`);
  }
}

/**
 * A counting semaphore. `acquire` resolves with a one-shot `release`, in the
 * order the waiters asked.
 *
 * @example
 * const release = await pool.acquire();
 * try { await work(); } finally { release(); }
 */
export class SlotPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`SlotPool: limit must be a positive integer, received ${limit}`);
    }
  }

  /** Slots in use right now. */
  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handOver();
    };
  }

  /** Gives the slot to the next waiter, or frees it when nobody waits. */
  private handOver(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/** One child a supervisor is watching. */
export interface SupervisedChild {
  readonly label: string;
  readonly pid: number;
  /** True when the child leads its own process group. */
  readonly ownsGroup: boolean;
  /** Settles once the child has exited. */
  readonly exited: Promise<unknown>;
  /** Signals the direct child only. */
  signal(signal: NodeJS.Signals): void;
}

/** What a supervisor needs from the process it runs in, so tests can fake it. */
export interface SupervisorHost {
  /** Registers a handler for `name`; the result removes it. */
  onSignal(name: CancelSignal, handler: () => void): () => void;
  /** Registers a handler for the process ending; the result removes it. */
  onExit(handler: () => void): () => void;
  /** Signals every process in group `pid`; a vanished group is not an error. */
  killGroup(pid: number, signal: NodeJS.Signals): void;
  exit(status: number): never;
  sleep(ms: number): Promise<void>;
  now(): number;
  report(message: string): void;
  readonly graceMs: number;
}

/** The host that is the running process. */
export function processHost(): SupervisorHost {
  return {
    onSignal(name, handler) {
      process.on(name, handler);
      return () => {
        process.off(name, handler);
      };
    },
    onExit(handler) {
      process.on('exit', handler);
      return () => {
        process.off('exit', handler);
      };
    },
    killGroup(pid, signal) {
      try {
        process.kill(-pid, signal);
      } catch {
        // The group can be fully reaped between the decision and the call.
      }
    },
    exit: (status) => process.exit(status),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    report(message) {
      try {
        error(message);
      } catch {
        // A hung-up terminal has nowhere to print to; stopping the children matters more.
      }
    },
    graceMs: CANCEL_GRACE_MS,
  };
}

/**
 * Watches a runner's live children and stops them when the runner is cancelled.
 * Signal handlers exist only while a child is live, so a script that has
 * nothing running keeps the default dispositions.
 *
 * @example
 * const release = supervisor.adopt({ label, pid, ownsGroup: true, exited, signal });
 * try { await exited; } finally { release(); }
 */
export class ChildSupervisor {
  private readonly live = new Set<SupervisedChild>();
  private removeHandlers: Array<() => void> = [];
  private firstSignalAt: number | null = null;

  constructor(private readonly host: SupervisorHost) {}

  /** True once a cancelling signal arrived; the supervisor owns the exit from then on. */
  get cancelling(): boolean {
    return this.firstSignalAt !== null;
  }

  /** Starts watching `child`; the result stops, and must run once the child exited. */
  adopt(child: SupervisedChild): () => void {
    this.live.add(child);
    this.install();
    return () => {
      this.live.delete(child);
      if (this.live.size === 0 && !this.cancelling) this.uninstall();
    };
  }

  private install(): void {
    if (this.removeHandlers.length > 0) return;
    this.removeHandlers = [
      ...CANCEL_SIGNALS.map((name) =>
        this.host.onSignal(name, () => {
          // Whatever goes wrong while stopping, the runner must still end.
          this.cancel(name).catch(() => this.host.exit(cancelExitStatus(name)));
        })
      ),
      this.host.onExit(() => this.stopAll('SIGTERM')),
    ];
  }

  private uninstall(): void {
    for (const remove of this.removeHandlers) remove();
    this.removeHandlers = [];
  }

  /** Delivers `signal` to every live child, the group of each that has one. */
  private stopAll(signal: NodeJS.Signals): void {
    for (const child of this.live) {
      if (child.ownsGroup) this.host.killGroup(child.pid, signal);
      else child.signal(signal);
    }
  }

  private async cancel(name: CancelSignal): Promise<void> {
    const now = this.host.now();
    if (this.firstSignalAt !== null) {
      if (now - this.firstSignalAt < REPEAT_WINDOW_MS) return;
      this.stopAll('SIGKILL');
      return this.host.exit(cancelExitStatus(name));
    }
    this.firstSignalAt = now;

    const labels = [...this.live].map((child) => child.label);
    if (labels.length > 0) {
      this.host.report(
        `\n${name}: stopping ${labels.length} running command(s): ${labels.join(', ')}`
      );
    }
    this.forward(name);

    if (!(await this.exitedWithin(this.host.graceMs))) {
      const left = [...this.live].map((child) => child.label).join(', ');
      this.host.report(`${name}: still running after ${this.host.graceMs}ms, killing: ${left}`);
      this.stopAll('SIGKILL');
      await this.exitedWithin(KILL_WAIT_MS);
    }
    return this.host.exit(cancelExitStatus(name));
  }

  /**
   * Passes the signal on. A child in its own group gets it from here and only
   * from here. An interactive child shares the terminal's foreground group, so
   * a Ctrl-C already reached it from the kernel; sending SIGINT again would
   * make it see two.
   */
  private forward(name: CancelSignal): void {
    for (const child of this.live) {
      if (child.ownsGroup) this.host.killGroup(child.pid, name);
      else if (name !== 'SIGINT') child.signal(name);
    }
  }

  /** Waits for every live child to exit, up to `ms`; reports whether they did. */
  private exitedWithin(ms: number): Promise<boolean> {
    const everyone = Promise.allSettled([...this.live].map((child) => child.exited)).then(
      () => true
    );
    return Promise.race([everyone, this.host.sleep(ms).then(() => false)]);
  }
}
