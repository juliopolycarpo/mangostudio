/**
 * What `preloadWhenIdle` needs from the browser. Injected so a test can drive
 * the clock and the connection hint without a real event loop.
 */
export interface IdleEnvironment {
  /** `requestIdleCallback`, absent in Safari. */
  readonly requestIdle?: (run: () => void, options: { timeout: number }) => number;
  readonly cancelIdle?: (handle: number) => void;
  readonly setTimer: (run: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
  /** The person asked the browser to spend less data (`navigator.connection.saveData`). */
  readonly saveData: () => boolean;
}

/** Idle time that never comes (a page that is always busy) still ends after this. */
export const IDLE_PRELOAD_TIMEOUT_MS = 3_000;
/** Where there is no `requestIdleCallback`, wait this long after the call instead. */
export const IDLE_PRELOAD_FALLBACK_DELAY_MS = 2_000;

function browserEnvironment(): IdleEnvironment {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return {
    requestIdle:
      typeof window.requestIdleCallback === 'function'
        ? (run, options) => window.requestIdleCallback(run, options)
        : undefined,
    cancelIdle: (handle) => window.cancelIdleCallback?.(handle),
    setTimer: (run, delayMs) => window.setTimeout(run, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
    saveData: () => connection?.saveData === true,
  };
}

/**
 * Starts `tasks` (each a chunk `preload`) once the page has gone quiet, so code
 * a person is likely to need is already in by the time they ask for it, without
 * competing with the first paint for bandwidth.
 *
 * Does nothing when the browser reports a data-saver preference: there the
 * chunk is fetched on demand, or on a hover, instead of speculatively.
 *
 * @returns a function that cancels the pending start; calling it after the tasks ran is harmless.
 */
export function preloadWhenIdle(
  tasks: readonly (() => void)[],
  environment: IdleEnvironment = browserEnvironment()
): () => void {
  if (tasks.length === 0 || environment.saveData()) return () => undefined;
  const run = () => {
    for (const task of tasks) task();
  };
  if (environment.requestIdle !== undefined) {
    const handle = environment.requestIdle(run, { timeout: IDLE_PRELOAD_TIMEOUT_MS });
    return () => environment.cancelIdle?.(handle);
  }
  const handle = environment.setTimer(run, IDLE_PRELOAD_FALLBACK_DELAY_MS);
  return () => environment.clearTimer(handle);
}
