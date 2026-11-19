import { createDiagnosticLogger } from '../lib/logger';

export const GENERATED_IMAGE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const logger = createDiagnosticLogger('generated-image-sweep');

export interface GeneratedImageSweep {
  run(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Runs the unreferenced-image sweep once now and then on a timer, never two at
 * once. The first run is not awaited by the caller: reclaiming disk space must
 * not delay the server from listening. Stopping clears the timer and waits for
 * an in-flight sweep to settle.
 */
export function startGeneratedImageSweep(sweep: () => Promise<unknown>): GeneratedImageSweep {
  let inFlight: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = sweep()
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
