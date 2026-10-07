// The real process behind a test worker: spawns the planned command, streams
// its output line by line under the worker's name, and reports how it ended.
// The verdict logic is in ./test-workers.ts and never sees a process.

import type { WorkerExit, WorkerHandle, WorkerPlan } from './test-workers';

/** Where a worker's output lines go; the real ones are `process.stdout` and `process.stderr`. */
export interface LineSinks {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
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
 *
 * @example
 * const handle = startWorkerProcess(plan, '[api-unit 2/4] ');
 * const { exitCode } = await handle.exited;
 */
export function startWorkerProcess(
  plan: WorkerPlan,
  prefix: string,
  sinks: LineSinks = stdSinks,
  drainGraceMs: number = DRAIN_GRACE_MS
): WorkerHandle {
  const child = Bun.spawn({
    cmd: [...plan.argv],
    cwd: plan.cwd,
    env: process.env as Record<string, string>,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
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

  return { exited, kill: (signal) => child.kill(signal) };
}
