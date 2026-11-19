import { describe, expect, it, mock } from 'bun:test';

import {
  GENERATED_IMAGE_SWEEP_INTERVAL_MS,
  startGeneratedImageSweep,
} from '../../../src/server/generated-image-sweep';

describe('generated image sweep', () => {
  it('runs once at start, skips an overlapping run, and runs again once settled', async () => {
    let releaseFirstRun: () => void = () => undefined;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const sweepOnce = mock(() => firstRun);
    const sweep = startGeneratedImageSweep(sweepOnce);

    try {
      expect(GENERATED_IMAGE_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
      expect(sweepOnce).toHaveBeenCalledTimes(1);

      const overlapping = sweep.run();
      expect(sweepOnce).toHaveBeenCalledTimes(1);

      releaseFirstRun();
      await overlapping;
      await sweep.run();
      expect(sweepOnce).toHaveBeenCalledTimes(2);
    } finally {
      await sweep.stop();
    }
  });

  it('logs a failed sweep instead of rejecting, so the next run still happens', async () => {
    const sweepOnce = mock(() => Promise.reject(new Error('images dir unreadable')));
    const sweep = startGeneratedImageSweep(sweepOnce);

    try {
      // The first call joins the start-up run, which has failed by the time it settles.
      await expect(sweep.run()).resolves.toBeUndefined();
      await expect(sweep.run()).resolves.toBeUndefined();
      expect(sweepOnce).toHaveBeenCalledTimes(2);
    } finally {
      await sweep.stop();
    }
  });
});
