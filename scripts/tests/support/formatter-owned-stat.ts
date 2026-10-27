import { readFile } from 'node:fs/promises';

/** Named controls can order a private deadline, stat read and cleanup watchdog. */
export interface FormatterStatHost {
  timeout(timeoutMs: number): AbortSignal;
  read(pid: number, signal: AbortSignal): Promise<string>;
  watchdog(callback: () => void, ms: number): () => void;
}

const STAT_HOST: FormatterStatHost = {
  timeout: (timeoutMs) => AbortSignal.timeout(timeoutMs),
  read: (pid, signal) => readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal }),
  watchdog(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * A stat read rejected by its own observed deadline, retaining the original failure.
 * @example if (error instanceof FormatterStatReadExpiry) console.error(error.timeoutMs);
 */
export class FormatterStatReadExpiry extends Error {
  constructor(
    readonly pid: number,
    readonly timeoutMs: number,
    readonly reason: unknown,
    error: unknown
  ) {
    super(`formatter ${pid}: owned stat read budget expired after ${timeoutMs}ms`, {
      cause: error,
    });
    this.name = 'FormatterStatReadExpiry';
  }
}

type StatObservation = { value: string; expired: boolean } | { error: unknown; expired: boolean };

/**
 * Read a Linux process stat with an owned deadline, retaining independent failures.
 * @example const stat = await readOwnedFormatterStat(process.pid, 300);
 */
export async function readOwnedFormatterStat(
  pid: number,
  timeoutMs: number,
  host: FormatterStatHost = STAT_HOST
): Promise<string | undefined> {
  const signal = host.timeout(timeoutMs);
  let expired = false;
  let finished = false;
  let notify!: () => void;
  const aborted = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const onAbort = (): void => {
    if (!finished) expired = true;
    notify();
  };
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) onAbort();
  try {
    const settled: Promise<StatObservation> = host.read(pid, signal).then(
      (value) => {
        finished = true;
        return { value, expired };
      },
      (error: unknown) => {
        finished = true;
        return { error, expired };
      }
    );
    let observation = await Promise.race([settled, aborted.then(() => undefined)]);
    if (!observation) {
      const cleanupMs = 300;
      let cancel = (): void => {};
      try {
        observation = await Promise.race([
          settled,
          new Promise<undefined>((resolve) => {
            cancel = host.watchdog(() => resolve(undefined), cleanupMs);
          }),
        ]);
      } finally {
        cancel();
      }
      if (!observation)
        throw new Error(
          `formatter ${pid}: stat read did not settle within ${cleanupMs}ms after expiry`,
          {
            cause: signal.reason,
          }
        );
    }
    if ('value' in observation) {
      if (observation.expired)
        throw new Error(`formatter ${pid}: expected stat read before its private deadline`, {
          cause: signal.reason,
        });
      return observation.value;
    }
    const { error } = observation;
    if (
      !observation.expired &&
      error instanceof Error &&
      ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return undefined;
    if (
      observation.expired &&
      error instanceof Error &&
      error.name === 'AbortError' &&
      (error as NodeJS.ErrnoException).code === 'ABORT_ERR' &&
      error.cause === signal.reason
    )
      throw new FormatterStatReadExpiry(pid, timeoutMs, signal.reason, error);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
