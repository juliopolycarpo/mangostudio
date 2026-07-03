/**
 * Quota alert detection over successive connector-usage observations: fire
 * once when a window crosses the configured used-percent threshold, and once
 * when a previously exhausted window resets. Pure state-in/state-out so the
 * firing rules are unit-testable; the hook owns wiring events to toasts.
 */

import type { Connector } from '@mangostudio/shared';
import type { ChatGptUsageWindowKey } from '@mangostudio/shared/connectors';

/** Alert threshold in used-percent; null means alerts are off. */
export type UsageAlertThreshold = 75 | 90 | null;

export const USAGE_ALERT_THRESHOLDS: readonly (75 | 90)[] = [75, 90];
export const DEFAULT_USAGE_ALERT_THRESHOLD: UsageAlertThreshold = 90;

export interface UsageAlertEvent {
  kind: 'threshold' | 'reset';
  connectorId: string;
  connectorName: string;
  window: ChatGptUsageWindowKey;
  usedPercent: number;
}

interface WindowObservation {
  usedPercent: number;
}

/** Last observed used-percent per `${connectorId}:${window}`. */
export type UsageAlertState = ReadonlyMap<string, WindowObservation>;

export const EMPTY_USAGE_ALERT_STATE: UsageAlertState = new Map();

const WINDOW_KEYS: readonly ChatGptUsageWindowKey[] = ['primary', 'secondary'];

/**
 * Compares the current connector usage against the previous observations.
 * A threshold alert fires on an upward crossing (previous observation below
 * the threshold — or none — and the current one at/above it); it cannot
 * re-fire until the window dips below the threshold again. A reset alert
 * fires when a window observed at 100% drops back down.
 */
export function detectUsageAlerts(
  previous: UsageAlertState,
  connectors: readonly Connector[],
  threshold: UsageAlertThreshold
): { events: UsageAlertEvent[]; next: UsageAlertState } {
  const events: UsageAlertEvent[] = [];
  const next = new Map<string, WindowObservation>();

  for (const connector of connectors) {
    if (!connector.usage) continue;
    for (const windowKey of WINDOW_KEYS) {
      const window = connector.usage[windowKey];
      if (!window) continue;

      const key = `${connector.id}:${windowKey}`;
      const prev = previous.get(key);
      next.set(key, { usedPercent: window.usedPercent });
      if (threshold === null) continue;

      const base = {
        connectorId: connector.id,
        connectorName: connector.name,
        window: windowKey,
        usedPercent: window.usedPercent,
      };
      if (prev && prev.usedPercent >= 100 && window.usedPercent < prev.usedPercent) {
        events.push({ kind: 'reset', ...base });
      } else if (
        window.usedPercent >= threshold &&
        (prev === undefined || prev.usedPercent < threshold)
      ) {
        events.push({ kind: 'threshold', ...base });
      }
    }
  }

  return { events, next };
}
