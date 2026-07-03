/**
 * Hook: in-app quota alerts for ChatGPT connectors. Watches the connector
 * usage snapshots as they refresh and toasts once per threshold crossing and
 * once per reset of a previously exhausted window. Observations live at module
 * scope so remounting the settings page never re-fires an alert; the threshold
 * is a per-device preference in localStorage.
 */

import type { Connector } from '@mangostudio/shared';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import {
  DEFAULT_USAGE_ALERT_THRESHOLD,
  detectUsageAlerts,
  EMPTY_USAGE_ALERT_STATE,
  type UsageAlertState,
  type UsageAlertThreshold,
} from '../lib/usage-alerts';

const STORAGE_KEY = 'mango.chatgpt-usage-alert-threshold';

let alertState: UsageAlertState = EMPTY_USAGE_ALERT_STATE;

function readStoredThreshold(): UsageAlertThreshold {
  switch (window.localStorage.getItem(STORAGE_KEY)) {
    case 'off':
      return null;
    case '75':
      return 75;
    case '90':
      return 90;
    default:
      return DEFAULT_USAGE_ALERT_THRESHOLD;
  }
}

export function useChatGptUsageAlerts(connectors: Connector[]) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [threshold, setThreshold] = useState<UsageAlertThreshold>(readStoredThreshold);

  useEffect(() => {
    const { events, next } = detectUsageAlerts(alertState, connectors, threshold);
    alertState = next;

    const s = t.settings.connectors;
    for (const event of events) {
      const windowName =
        event.window === 'primary'
          ? s.chatgptUsagePrimaryFallback
          : s.chatgptUsageSecondaryFallback;
      if (event.kind === 'reset') {
        toast(
          s.chatgptAlertWindowReset
            .replace('{name}', event.connectorName)
            .replace('{window}', windowName),
          'success'
        );
      } else {
        toast(
          s.chatgptAlertThresholdCrossed
            .replace('{name}', event.connectorName)
            .replace('{window}', windowName)
            .replace('{percent}', String(Math.round(event.usedPercent))),
          'info'
        );
      }
    }
  }, [connectors, threshold, t, toast]);

  const updateThreshold = useCallback((value: UsageAlertThreshold) => {
    setThreshold(value);
    window.localStorage.setItem(STORAGE_KEY, value === null ? 'off' : String(value));
  }, []);

  return { threshold, updateThreshold };
}

export function resetChatGptUsageAlertStateForTests(): void {
  alertState = EMPTY_USAGE_ALERT_STATE;
}
