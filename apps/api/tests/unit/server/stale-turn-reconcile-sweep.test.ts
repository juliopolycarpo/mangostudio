import { describe, expect, it, mock } from 'bun:test';
import {
  STALE_TURN_RECONCILE_INTERVAL_MS,
  startStaleTurnReconcileSweep,
} from '../../../src/server/stale-turn-reconcile-sweep';

describe('stale-turn reconcile sweep', () => {
  it('uses the bounded sweep interval and skips overlapping runs', async () => {
    let releaseFirstRun: () => void = () => undefined;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const reconcile = mock(() => firstRun);
    const sweep = startStaleTurnReconcileSweep(reconcile);

    try {
      expect(STALE_TURN_RECONCILE_INTERVAL_MS).toBe(15_000);

      const first = sweep.run();
      const overlapping = sweep.run();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(overlapping).toBe(first);

      releaseFirstRun();
      await first;
      await sweep.run();
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      await sweep.stop();
    }
  });
});
