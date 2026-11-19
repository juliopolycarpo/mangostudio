import { createDiagnosticLogger } from '../lib/logger';

export const GENERATED_IMAGE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const logger = createDiagnosticLogger('generated-image-sweep');

export interface GeneratedImageSweep {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export interface GeneratedImageSweepOptions {
  /**
   * A pass that must settle before the sweep reads anything. Streaming turns
   * keep their latest image parts in checkpoint deltas until the stale-turn
   * reconcile pass folds them into the message rows, so a sweep that ran ahead
   * of that pass could see a delta-only file as unreferenced. A rejection counts
   * as settled: the sweep is guarded by the file age as well.
   */
  after?: Promise<unknown>;
}

/**
 * Runs the unreferenced-image sweep once now and then on a timer, never two at
 * once. The first run is not awaited by the caller: reclaiming disk space must
 * not delay the server from listening. Stopping clears the timer and waits for
 * an in-flight sweep to settle.
 */
export function startGeneratedImageSweep(
  sweep: () => Promise<unknown>,
  options: GeneratedImageSweepOptions = {}
): GeneratedImageSweep {
  let inFlight: Promise<void> | null = null;
  const ready = options.after?.then(
    () => undefined,
    () => undefined
  );

  const run = (): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = (ready ? ready.then(sweep) : sweep())
      .then(() => undefined)
      .catch((error: unknown) => logger.error('sweep_failed', { error }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  void run();
  const timer = setInterval(() => void run(), GENERATED_IMAGE_SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    run,
    async stop(): Promise<void> {
      clearInterval(timer);
      await inFlight;
    },
  };
}
