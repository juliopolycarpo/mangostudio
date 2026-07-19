import { createDiagnosticLogger } from '../lib/logger';

export const STALE_TURN_RECONCILE_INTERVAL_MS = 15_000;

const logger = createDiagnosticLogger('stale-turn-reconcile');

export interface StaleTurnReconcileSweep {
  run(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Runs stale-turn reconciliation periodically without overlapping executions.
 * Stopping clears the timer and waits for an in-flight sweep to settle.
 */
export function startStaleTurnReconcileSweep(
  reconcile: () => Promise<unknown>
): StaleTurnReconcileSweep {
  let inFlight: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = reconcile()
      .then(() => undefined)
      .catch((error: unknown) => logger.error('sweep_failed', { error }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = setInterval(() => void run(), STALE_TURN_RECONCILE_INTERVAL_MS);
  timer.unref();

  return {
    run,
    async stop(): Promise<void> {
      clearInterval(timer);
      await inFlight;
    },
  };
}
