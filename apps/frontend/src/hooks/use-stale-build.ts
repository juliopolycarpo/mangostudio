import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import { useEffect, useSyncExternalStore } from 'react';

import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
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

/**
 * Tells the monitor when the hub is reachable again, so a probe that could not
 * reach it during an upgrade restart is repeated once it can.
 *
 * Two signals: the realtime socket's `subscribed` ack after a reconnect (the
 * hub restarting drops the socket and the client reconnects on its own), and the
 * browser's `online` event for a dropped network. Neither does anything unless
 * the last probe was inconclusive, so they cost nothing in the normal case.
 *
 * @example
 * useRecheckStaleBuildWhenReachable(monitor);
 */
export function useRecheckStaleBuildWhenReachable(
  monitor: StaleBuildMonitor = staleBuildMonitor
): void {
  useRealtimeInvalidation(ACTIVITY_TOPIC, 'stale-build-recheck', (signal) => {
    if (signal.type === 'subscribed') monitor.noteHubReachable();
  });
  useEffect(() => {
    const onOnline = () => monitor.noteHubReachable();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [monitor]);
}
