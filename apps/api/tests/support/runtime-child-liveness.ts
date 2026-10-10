/**
 * A liveness checkpoint for a runtime child that is expected to keep running
 * for a stated window, e.g. while a graceful shutdown waits on an active install.
 */

/** The part of a spawned process the checkpoint observes. */
export interface ExitObservable {
  readonly exited: Promise<number>;
}

/**
 * Resolves once `windowMs` has elapsed with `child` still running; rejects as
 * soon as `child` exits inside the window, including one that exited before the
 * call. Start it before the signal that begins the window so no exit is missed.
 *
 * @example
 * const alive = expectRuntimeChildAlive(child, 5_000);
 * child.kill('SIGTERM');
 * await alive;
 */
export async function expectRuntimeChildAlive(
  child: ExitObservable,
  windowMs: number
): Promise<void> {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`expected windowMs: positive finite number | received: ${windowMs}`);
  }
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const windowElapsed = new Promise<'alive'>((resolve) => {
    timer = setTimeout(() => resolve('alive'), windowMs);
  });
  try {
    const outcome = await Promise.race([windowElapsed, child.exited]);
    if (outcome === 'alive') return;
    const elapsed = Math.round(performance.now() - startedAt);
    throw new Error(
      `expected runtime child: alive at ${windowMs / 1000} s | ` +
        `received: exited with code ${outcome} after ${elapsed} ms`
    );
  } finally {
    clearTimeout(timer);
  }
}
