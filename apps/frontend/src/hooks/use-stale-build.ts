import { useSyncExternalStore } from 'react';

import { staleBuildMonitor } from '@/lib/stale-build';
import type { StaleBuildMonitor } from '@/lib/stale-build';

/**
 * True once any lazy chunk failure found that the hub serves a newer build than
 * this tab. Drives the single "reload" notice, so surfaces that fail together do
 * not each ask for a reload.
 *
 * @example
 * const stale = useBuildIsStale();
 */
export function useBuildIsStale(monitor: StaleBuildMonitor = staleBuildMonitor): boolean {
  return useSyncExternalStore(monitor.subscribe, monitor.isStale, () => false);
}
