// The real process behind a test worker: spawns the planned command, streams
// its output line by line under the worker's name, and reports how it ended.
// The verdict logic is in ./test-workers.ts and never sees a process.

import { NewlineSplitter, type SplitLine } from './newline-splitter';
import type { GuardedChild } from './runner-guardian';
import {
  killProcessGroup,
  settleWorker,
  signalWorker,
  WORKER_TOKEN_ENV,
} from './test-worker-settle';
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
 * for settlement, so it is kept short enough that the full settlement grace
 * (`SETTLE_GRACE_MS`) still ends before the supervisor's deadline.
 */
export const EXIT_ABANDON_MS = 500;

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

/** What {@link startWorkerProcess} asks of the machine; every field defaults to the real one. */
export interface WorkerHost {
  readonly platform?: NodeJS.Platform;
  readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
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
 * How long the lane's guardian gives a worker between SIGTERM and SIGKILL once
 * the lane script is gone. The same 5 s as the runner's `CANCEL_GRACE_MS`, kept
 * here so the lane script does not load ./process-tree.ts: every file it loads
 * is an input of the cached API unit lane.
 */
export const WORKER_GUARDIAN_GRACE_MS = 5_000;

/** What {@link guardWorkerSpawn} needs of a guardian link; `GuardianLink` is the real one. */
export interface WorkerGuardian {
  /** Starts the guardian if it is not running yet. */
  open(): void;
  /** Registers a worker; the result deregisters it. */
  watch(child: GuardedChild): () => void;
}

/**
 * A `SpawnWorker` whose workers the lane's guardian stops when the lane script
 * is SIGKILLed (see ./runner-guardian.ts). Without it they ran on to the end of
 * their files: the launcher between the lane and `bun test` does not notice its
 * parent die, and a settling worker leads a group no one else signals.
 *
 * A worker that leads its group is registered as the group; any other as its
 * pid, the launcher, which forwards SIGTERM to its `bun test`. The guardian is
 * opened before the spawn and the worker is deregistered once it has exited.
 *
 * @example
 * const spawn = guardWorkerSpawn(new GuardianLink(() => launchGuardian(5_000), error));
 */
export function guardWorkerSpawn(
  guardian: WorkerGuardian,
  spawn: SpawnWorker = spawnWorkerChild
): SpawnWorker {
  return (options) => {
    guardian.open();
    const child = spawn(options);
    const release = guardian.watch({ kind: options.detached ? 'group' : 'pid', pid: child.pid });
    // A rejected exit wait still means the lane has stopped waiting for it.
    void child.exited.then(release, release);
    return child;
  };
}

/** The longest worker output line {@link pumpLines} holds, in characters. */
const WORKER_LINE_MAX_CHARS = 1024 * 1024;

/**
 * Reads `stream` and hands over each complete line (without its newline). A
 * last line with no newline is delivered when the stream ends, or when `stop`
 * aborts: that cancels the reader, so a pipe nobody closes cannot keep it open.
 *
 * A line over `maxLineLength` is delivered cut to it, followed by one message
 * naming its length and the limit, and the lines after it arrive as usual: a
 * worker that prints one huge line still gets its failure summary through. The
 * pipe is always drained, so a worker is never blocked on it.
 *
 * @example
 * await pumpLines(child.stderr, (line) => console.error(`[w1] ${line}`), stop.signal);
 */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  stop?: AbortSignal,
  maxLineLength: number = WORKER_LINE_MAX_CHARS
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines = new NewlineSplitter({ maxLineLength, onOverflow: 'truncate' });
  const reportCut = ({ length }: SplitLine): void => {
    if (length > maxLineLength) {
      onLine(
        `Output line of ${length} characters exceeds the ${maxLineLength}-character limit; cut to the limit`
      );
    }
  };
  const deliver = (text: string): void => {
    for (const record of lines.pushRecords(text)) {
      onLine(record.line.replace(/\r$/, ''));
      reportCut(record);
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
  // The tail is not CR-trimmed: no newline ended it.
  const rest = lines.finishRecord();
  if (rest.length > 0) {
    onLine(rest.line);
    reportCut(rest);
  }
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
 * On POSIX every worker leads a process group of its own, so a signal to `kill`
 * reaches everything it started, and a group signal a test sends to itself ends
 * one worker, not the runner and `bun run` with it. The group is SIGKILLed once
 * the worker has exited and its pipes have drained, so a stray child cannot
 * outlive it. A worker whose plan settles also has `settle`, which reports what
 * is still running in that group, or carrying the worker's token, instead of
 * killing it silently. Windows has no process groups; there the worker is a
 * plain child and has nothing to settle.
 *
 * `platform` and `sendSignal` default to the machine's; a test names fakes for
 * both so the Windows and POSIX branches run on every host.
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
  spawn: SpawnWorker = spawnWorkerChild,
  host: WorkerHost = {}
): WorkerHandle {
  const { platform = process.platform, sendSignal = process.kill } = host;
  const leadsGroup = platform !== 'win32';
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
    // A worker that settles proves its group empty in `settle`, which reports
    // what it had to kill. Any other worker's group is reaped here, so a stray
    // child neither survives the worker nor holds the lane's pipes.
    // A pid that is no group id throws here and surfaces as the worker's start error.
    if (leadsGroup && !plan.settle) killProcessGroup(child.pid, 'SIGKILL', sendSignal);
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
          signalWorker({ pgid: child.pid, token: token ?? '' }, signal, { sendSignal });
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
