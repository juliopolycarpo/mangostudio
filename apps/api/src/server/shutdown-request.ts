/**
 * A way to ask the running server to stop without importing the server. The
 * bootstrap registers its graceful stop here; anything that needs to end the
 * process — the signal handlers, a restart requested over the API — calls
 * `requestShutdown` and never reaches into the bootstrap module, which would
 * pull the whole app graph into a cycle.
 */

type ShutdownHandler = () => Promise<void>;

let handler: ShutdownHandler | null = null;
let requested = false;

/** Install the work that runs before exit. // Usage: registerShutdownHandler(gracefulStop) */
export function registerShutdownHandler(next: ShutdownHandler): void {
  handler = next;
}

/**
 * Run the registered stop once and exit 0. A second call while the first is
 * in flight is ignored, so SIGINT plus a `stop` SIGTERM cannot run the stop
 * twice and close the database twice.
 * // Usage: requestShutdown()
 */
export function requestShutdown(): void {
  if (requested) return;
  requested = true;
  const work = handler ? handler() : Promise.resolve();
  void work.finally(() => process.exit(0));
}

/** Test seam: forget the handler and the in-flight flag. */
export function resetShutdownRequestForTest(): void {
  handler = null;
  requested = false;
}
