// The real process behind a test worker: spawns the planned command, streams
// its output line by line under the worker's name, and reports how it ended.
// The verdict logic is in ./test-workers.ts and never sees a process.

import { settleWorker, signalWorker, WORKER_TOKEN_ENV } from './test-worker-settle';
import type { WorkerExit, WorkerHandle, WorkerPlan } from './test-workers';

/** Where a worker's output lines go; the real ones are `process.stdout` and `process.stderr`. */
export interface LineSinks {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * The environment a worker starts with: the runner's own, less the variables
 * that would point every worker at one shared home. `MANGO_HOME` moves the
 * runtime's state (`runtime.json`, its lock files, the audit log) out of the
 * temporary HOME the launcher gives each worker, so a developer who exports it
 * would have all workers contend for one directory (and tests written for the
 * real runtime would write into it). A test that needs one sets its own.
 *
 * @example
 * workerEnvironment({ MANGO_HOME: '/home/me/.mango', PATH: '/bin' }, plan); // => { PATH: '/bin', ... }
 */
export function workerEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  plan: Pick<WorkerPlan, 'env'>
): Record<string, string> {
  const inherited = Object.entries(ambient).filter(
    (entry): entry is [string, string] => entry[0] !== 'MANGO_HOME' && entry[1] !== undefined
  );
  return { ...Object.fromEntries(inherited), ...plan.env };
}

/** How long to keep reading a pipe after the worker has exited, in case a grandchild still holds it. */
const DRAIN_GRACE_MS = 2_000;

/**
 * After the escalation SIGKILL, how long to wait on `child.exited` before
 * abandoning it. The real teardown is the group signal plus `settle()`'s
 * process-table reap, neither of which needs `child.exited`; under Bun 1.4.3 a
 * SIGKILLed, detached child's `.exited` can stay pending even though the process
 * is already gone, so an unbounded wait here stalls the whole lane to its outer
 * deadline. It is spent after the escalation (`GROUP_KILL_AFTER_MS` in
 * ./test-workers.ts), out of what the outer supervisor's `CANCEL_GRACE_MS` leaves
 * for settlement, so it is kept short: a group that is gone by then settles on
 * the first poll, and only one that outlives its SIGKILL for most of the
 * settlement grace overruns the supervisor.
 */
const EXIT_ABANDON_MS = 500;

/** What the lane reads from a started worker: the part of a `Bun.spawn` subprocess it depends on. */
export interface WorkerChild {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<unknown>;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/** What a worker is started with. `detached` makes it the leader of its own process group. */
interface WorkerSpawnOptions {
  readonly cmd: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly detached: boolean;
}

/**
 * Starts the process behind a worker. The real one is `Bun.spawn` with piped
 * output; a test supplies its own to control how the child reports its exit.
 *
 * @example
 * const spawn: SpawnWorker = (options) => recordingChild(spawnWorkerChild(options));
 */
export type SpawnWorker = (options: WorkerSpawnOptions) => WorkerChild;

/**
 * Spawns a worker as a real child with its input closed and its output piped.
 *
 * @example
 * const child = spawnWorkerChild({ cmd: ['bun', 'test'], cwd, env, detached: true });
 */
export const spawnWorkerChild: SpawnWorker = (options) =>
  Bun.spawn({ ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });

/**
 * Reads `stream` and hands over each complete line (without its newline). A
 * last line with no newline is delivered when the stream ends, or when `stop`
 * aborts: that cancels the reader, so a pipe nobody closes cannot keep it open.
 *
 * @example
 * await pumpLines(child.stderr, (line) => console.error(`[w1] ${line}`), stop.signal);
 */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  stop?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const deliver = (text: string): void => {
    pending += text;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      onLine(pending.slice(0, newline).replace(/\r$/, ''));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  };
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  if (stop?.aborted) cancel();
  else stop?.addEventListener('abort', cancel, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      deliver(decoder.decode(value, { stream: true }));
    }
    deliver(decoder.decode());
  } catch {
    // A stream that errors ends the pump; what it read stands.
  } finally {
    stop?.removeEventListener('abort', cancel);
  }
  if (pending) onLine(pending);
}

const stdSinks: LineSinks = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * Starts one worker. Output is prefixed with `prefix` line by line, so four
 * workers share a log without splitting each other's lines, and the last line
 * of a wedged lane still names the worker that went quiet.
 *
 * Once the worker has exited its pipes get `drainGraceMs` to close. A grandchild
 * that inherited them (a test that leaked a process) would otherwise hold the
 * lane open until it died; after the grace the readers are cancelled and the
 * worker is reported as it ended.
 * `env` defaults to the current process environment; controlled fixtures can
 * supply their own child environment without changing the worker's policy.
 * `spawn` defaults to a real child process.
 *
 * A worker whose plan settles (POSIX) leads a process group of its own, so a
 * signal to `kill` reaches everything it started, and `settle` reports what is
 * still running in that group, or carrying the worker's token, once it has
 * exited. Windows has no group to lead; there the worker is a plain child and
 * has nothing to settle.
 *
 * @example
 * const handle = startWorkerProcess(plan, '[api-unit 2/4] ');
 * const { exitCode } = await handle.exited;
 */
export function startWorkerProcess(
  plan: WorkerPlan,
  prefix: string,
  sinks: LineSinks = stdSinks,
  drainGraceMs: number = DRAIN_GRACE_MS,
  env: NodeJS.ProcessEnv = process.env,
  spawn: SpawnWorker = spawnWorkerChild
): WorkerHandle {
  const leadsGroup = plan.settle && process.platform !== 'win32';
  const child = spawn({
    cmd: [...plan.argv],
    cwd: plan.cwd,
    env: workerEnvironment(env, plan),
    detached: leadsGroup,
  });
  const stopReading = new AbortController();
  const pumps = [
    pumpLines(child.stdout, (line) => sinks.out(prefix + line), stopReading.signal),
    pumpLines(child.stderr, (line) => sinks.err(prefix + line), stopReading.signal),
  ];

  // After the escalation SIGKILL (see `kill` below) the worker's whole tree is
  // being torn down by the group signal and, for a settling worker, by the
  // token reap in `settle()`. Neither needs `child.exited`, so once that kill
  // has had a brief grace the lane abandons the exit wait rather than depend on
  // a `child.exited` that Bun 1.4.3 can leave pending for a dead detached child.
  const abandon = Promise.withResolvers<'abandoned'>();
  let abandonTimer: ReturnType<typeof setTimeout> | undefined;
  // Set once the exit wait is over, so a SIGKILL that arrives while the pipes
  // are still draining does not arm a timer nothing is left to clear.
  let exitWaitOver = false;

  const exited = (async (): Promise<WorkerExit> => {
    let outcome: 'exited' | 'abandoned';
    try {
      outcome = await Promise.race([child.exited.then(() => 'exited' as const), abandon.promise]);
    } catch (caught) {
      exitWaitOver = true;
      // A genuine `child.exited` rejection (a spawn or stdio failure) on the
      // non-abandoned path is the worker's own failure: let it propagate so
      // `runWorker` records it as `startError`, exactly as before the abandon
      // wait existed. Clean up first so the throw leaves no timer or pump
      // reading behind.
      clearTimeout(abandonTimer);
      stopReading.abort();
      await Promise.all(pumps);
      throw caught;
    }
    exitWaitOver = true;
    clearTimeout(abandonTimer);
    if (outcome === 'abandoned') {
      // A late `child.exited` rejection needs no handler of its own: the race
      // above already attached one, so it cannot surface as unhandled.
      // The pipes may still be held by a detached grandchild the reap is
      // clearing, so stop reading now instead of waiting out the drain grace.
      stopReading.abort();
    }
    const grace = setTimeout(() => stopReading.abort(), drainGraceMs);
    await Promise.all(pumps);
    clearTimeout(grace);
    // On the abandon path Bun may never have populated exitCode/signalCode; we
    // have already sent SIGKILL, so report that when the handle reported
    // neither — keeping WorkerExit's "exactly one set" contract without
    // pretending the handle itself observed an exit. The normal path is
    // unchanged: it reports whatever the handle recorded.
    const synthesizeKill =
      outcome === 'abandoned' && child.exitCode === null && child.signalCode === null;
    return { exitCode: child.exitCode, signal: synthesizeKill ? 'SIGKILL' : child.signalCode };
  })();

  const token = plan.env[WORKER_TOKEN_ENV];
  let signalError: { readonly cause: unknown } | undefined;
  return {
    exited,
    kill: (signal) => {
      if (!leadsGroup) {
        child.kill(signal);
      } else {
        try {
          signalWorker({ pgid: child.pid, token: token ?? '' }, signal);
        } catch (caught) {
          // Keep the escalation timer alive. Settlement retries the table and
          // reports the signaling failure after cleaning up what it can find.
          signalError ??= { cause: caught };
        }
      }
      // The escalation SIGKILL has reached the whole group (and the token
      // children of a settling worker); `settle()`'s reap, not `child.exited`,
      // is what proves them gone. Give the reported exit a short grace and then
      // abandon the wait so a wedged `child.exited` cannot hold the runner past
      // its outer deadline. Only a group leader qualifies: a plain child gets
      // neither the group signal nor a settlement reap, so abandoning its exit
      // would report a kill nothing has confirmed.
      if (leadsGroup && signal === 'SIGKILL' && !exitWaitOver) {
        abandonTimer ??= setTimeout(() => abandon.resolve('abandoned'), EXIT_ABANDON_MS);
      }
    },
    settle:
      leadsGroup && token
        ? async () => {
            const leftovers = await settleWorker({ who: { pgid: child.pid, token } });
            if (signalError) throw signalError.cause;
            return leftovers;
          }
        : undefined,
  };
}
