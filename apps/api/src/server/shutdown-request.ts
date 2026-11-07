/**
 * A way to ask the running server to stop without importing the server. The
 * bootstrap registers its graceful stop here; anything that needs to end the
 * process — the signal handlers, a restart requested over the API — calls
 * `requestShutdown` and never reaches into the bootstrap module, which would
 * pull the whole app graph into a cycle.
 */

type ShutdownHandler = () => Promise<void>;

/** Shorter than the successor's wait, so it never binds into a live predecessor. */
const SHUTDOWN_BUDGET_MS = 12_000;

let handler: ShutdownHandler | null = null;
let requested = false;

/** Install the work that runs before exit. // Usage: registerShutdownHandler(gracefulStop) */
export function registerShutdownHandler(next: ShutdownHandler): void {
  handler = next;
}

/**
 * Run the registered stop once; report cleanup failures with a nonzero exit.
 * A second call while the first is in flight is ignored, so SIGINT plus a
 * `stop` SIGTERM cannot run the stop
 * twice and close the database twice.
 * // Usage: requestShutdown()
 */
export function requestShutdown(budgetMs: number = SHUTDOWN_BUDGET_MS): void {
  if (requested) return;
  requested = true;
  const stop = handler;
  const work = Promise.resolve().then(() => stop?.());
  // Keep the watchdog alive while the stop is pending, even if it removed
  // the last event-loop handle without settling.
  const budget = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => budget.reject(new Error(`Shutdown did not complete within ${budgetMs}ms.`)),
    budgetMs
  );
  void Promise.race([work, budget.promise])
    .finally(() => clearTimeout(timer))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.warn('[api] Shutdown failed:', error);
        process.exit(1);
      }
    );
}

/** Test seam: forget the handler and the in-flight flag. */
export function resetShutdownRequestForTest(): void {
  handler = null;
  requested = false;
}
