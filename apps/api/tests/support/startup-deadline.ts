/**
 * A startup budget for a test fixture that waits on a child process.
 *
 * Hub dials are bounded by the protocol SDK's own `timeoutMs`; this is for the
 * fixtures that poll a spawned `serve` runtime's health endpoint before any
 * dial exists, and need one signal that carries a named reason when the budget
 * runs out.
 */

export interface StartupDeadline {
  /** Aborts once the deadline passes; `reason` is the error the waiter rejects with. */
  readonly signal: AbortSignal;
  /** Cancels the deadline. Safe to call after it already fired. */
  clear(): void;
}

/**
 * Starts a deadline that aborts with `message` after `timeoutMs`.
 *
 * The timer is unreferenced, so an armed deadline never keeps a process alive
 * on its own.
 *
 * @example
 * const deadline = startupDeadline(10_000, 'Serve health deadline exceeded 10000ms');
 * try {
 *   await waitForHealth(baseUrl, deadline.signal);
 * } finally {
 *   deadline.clear();
 * }
 */
export function startupDeadline(timeoutMs: number, message: string): StartupDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}
