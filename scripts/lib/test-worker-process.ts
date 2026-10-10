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
  env: NodeJS.ProcessEnv = process.env
): WorkerHandle {
  const leadsGroup = plan.settle && process.platform !== 'win32';
  const child = Bun.spawn({
    cmd: [...plan.argv],
    cwd: plan.cwd,
    env: workerEnvironment(env, plan),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: leadsGroup,
  });
  const stopReading = new AbortController();
  const pumps = [
    pumpLines(child.stdout, (line) => sinks.out(prefix + line), stopReading.signal),
    pumpLines(child.stderr, (line) => sinks.err(prefix + line), stopReading.signal),
  ];

  const exited = (async (): Promise<WorkerExit> => {
    await child.exited;
    const grace = setTimeout(() => stopReading.abort(), drainGraceMs);
    await Promise.all(pumps);
    clearTimeout(grace);
    return { exitCode: child.exitCode, signal: child.signalCode };
  })();

  const token = plan.env[WORKER_TOKEN_ENV];
  let signalError: { readonly cause: unknown } | undefined;
  return {
    exited,
    kill: (signal) => {
      if (!leadsGroup) {
        child.kill(signal);
        return;
      }
      try {
        signalWorker({ pgid: child.pid, token: token ?? '' }, signal);
      } catch (caught) {
        // Keep the escalation timer alive. Settlement retries the table and
        // reports the signaling failure after cleaning up what it can find.
        signalError ??= { cause: caught };
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
