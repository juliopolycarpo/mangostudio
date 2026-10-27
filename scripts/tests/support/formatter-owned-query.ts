import type { ReadableStreamDefaultReader } from 'node:stream/web';

export interface FormatterQueryResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signalCode?: NodeJS.Signals | number | null;
  readonly killed?: boolean;
}

interface QueryChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly signalCode: NodeJS.Signals | number | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): void;
}

/** Named query controls can order their private abort, exit and independent failures. */
export interface FormatterQueryHost {
  timeout(timeoutMs: number): AbortSignal;
  spawn(pid: number, signal: AbortSignal, onExit: (error?: Error) => void): QueryChild;
}

const QUERY_HOST: FormatterQueryHost = {
  timeout: (timeoutMs) => AbortSignal.timeout(timeoutMs),
  spawn(pid, signal, onExit) {
    return Bun.spawn(['ps', '-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args='], {
      env: { ...process.env, LC_ALL: 'C' },
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      killSignal: 'SIGTERM',
      onExit(_process, _code, _signal, error) {
        onExit(error);
      },
    });
  },
};

/**
 * An observed private query budget event, not proof of the OS signal's sole actor.
 * @example if (error instanceof FormatterQueryExpiry) console.error(error.timeoutMs);
 */
export class FormatterQueryExpiry extends Error {
  constructor(
    readonly pid: number,
    readonly timeoutMs: number,
    readonly result: FormatterQueryResult,
    reason: unknown
  ) {
    super(`formatter ${pid}: owned native query budget expired after ${timeoutMs}ms`, {
      cause: reason,
    });
    this.name = 'FormatterQueryExpiry';
  }
}

/**
 * Bound one native ps child with a private signal and retain abort/exit ordering.
 * @example const result = await queryOwnedFormatterProcess(marker.pid, remainingMs);
 */
export async function queryOwnedFormatterProcess(
  pid: number,
  timeoutMs: number,
  host: FormatterQueryHost = QUERY_HOST
): Promise<FormatterQueryResult> {
  const signal = host.timeout(timeoutMs);
  const cleanupMs = 300;
  let frozen = false;
  let ownedExpiryBeforeExit = false;
  let childExited = false;
  const independent: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  let notify!: (event: 'abort' | 'failure') => void;
  const event = new Promise<'abort' | 'failure'>((resolve) => {
    notify = resolve;
  });
  const onAbort = (): void => {
    if (!frozen) ownedExpiryBeforeExit = true;
    notify('abort');
  };
  const freeze = (): void => {
    frozen = true;
    signal.removeEventListener('abort', onAbort);
  };
  const failed = (error: unknown): never => {
    independent.push(error);
    freeze();
    notify('failure');
    throw error;
  };
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) onAbort();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = host.spawn(pid, signal, (error) => {
      if (error !== undefined) {
        independent.push(error);
        notify('failure');
      }
      freeze();
    });
    const readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; done: boolean }> = [];
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const state = { reader: stream.getReader(), done: false };
      readers.push(state);
      const { reader } = state;
      const decoder = new TextDecoder();
      let output = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return output + decoder.decode();
          output += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        state.done = true;
        reader.releaseLock();
      }
    };
    const reads = Promise.allSettled([
      drain(child.stdout).catch(failed),
      drain(child.stderr).catch(failed),
      child.exited.then((exitCode) => {
        childExited = true;
        freeze();
        return exitCode;
      }, failed),
    ]);
    const budget = new Promise<'budget'>((resolve) => {
      watchdog = setTimeout(() => resolve('budget'), timeoutMs);
    });
    const first = await Promise.race([reads.then(() => 'complete' as const), event, budget]);
    let incomplete = first === 'budget';
    let settled = first === 'complete';
    if (first === 'abort') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        settled = await Promise.race([
          reads.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), cleanupMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      incomplete = !settled;
    }
    if (settled && independent.length && !childExited) settled = false;
    if (!settled) {
      if (!childExited) {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      const cancels = readers
        .filter((state) => !state.done)
        .map(async ({ reader }) => {
          try {
            await reader.cancel();
          } catch (error) {
            cleanupFailures.push(error);
          }
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        settled = await Promise.race([
          Promise.allSettled([reads, ...cancels]).then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), cleanupMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!settled)
        cleanupFailures.push(
          new Error(`formatter ${pid}: native query cleanup did not settle within ${cleanupMs}ms`)
        );
      if (!childExited)
        cleanupFailures.push(new Error(`formatter ${pid}: native query exit was not confirmed`));
    }
    if (incomplete)
      cleanupFailures.unshift(
        new Error(`formatter ${pid}: native query observation incomplete after ${timeoutMs}ms`)
      );
    const failures = [...new Set([...independent, ...cleanupFailures])];
    if (failures.length) {
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        `formatter ${pid}: native query observation or cleanup failures`,
        { cause: failures[0] }
      );
    }
    if (!settled) throw new Error(`formatter ${pid}: expected complete native query observations`);
    const [stdout, stderr, exit] = await reads;
    if (
      stdout?.status !== 'fulfilled' ||
      stderr?.status !== 'fulfilled' ||
      exit?.status !== 'fulfilled'
    )
      throw new Error(`formatter ${pid}: expected complete native query observations`);
    const result = {
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: exit.value,
      signalCode: child.signalCode,
      killed: child.killed,
    };
    if (
      ownedExpiryBeforeExit &&
      result.exitCode === 143 &&
      (result.signalCode === 'SIGTERM' || result.signalCode === 15) &&
      !result.stdout.trim() &&
      !result.stderr.trim()
    ) {
      throw new FormatterQueryExpiry(pid, timeoutMs, result, signal.reason);
    }
    if (ownedExpiryBeforeExit) {
      throw Object.assign(
        new Error(
          `formatter ${pid}: native query returned after its private deadline | received: ${JSON.stringify(result)}`,
          { cause: signal.reason }
        ),
        { pid, timeoutMs, result }
      );
    }
    return result;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    freeze();
  }
}
