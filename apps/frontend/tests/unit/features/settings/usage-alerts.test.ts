import { describe, expect, it } from 'bun:test';
import type { Connector } from '@mangostudio/shared';
import {
  detectUsageAlerts,
  EMPTY_USAGE_ALERT_STATE,
} from '@/features/settings/connectors/lib/usage-alerts';

function chatgptConnector(
  id: string,
  windows: { primary?: number; secondary?: number }
): Connector {
  return {
    id,
    name: `name-${id}`,
    provider: 'chatgpt',
    configured: true,
    source: 'bun-secrets',
    maskedSuffix: null,
    baseUrl: null,
    updatedAt: 0,
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: [],
    userId: 'user-1',
    usage: {
      capturedAt: 0,
      source: 'endpoint',
      ...(windows.primary !== undefined ? { primary: { usedPercent: windows.primary } } : {}),
      ...(windows.secondary !== undefined ? { secondary: { usedPercent: windows.secondary } } : {}),
    },
  } as Connector;
}

describe('detectUsageAlerts', () => {
  it('fires once per window on an upward threshold crossing', () => {
    const first = detectUsageAlerts(
      EMPTY_USAGE_ALERT_STATE,
      [chatgptConnector('c1', { primary: 50, secondary: 92 })],
      90
    );
    expect(first.events).toEqual([
      {
        kind: 'threshold',
        connectorId: 'c1',
        connectorName: 'name-c1',
        window: 'secondary',
        usedPercent: 92,
      },
    ]);

    // Staying above the threshold does not re-fire.
    const second = detectUsageAlerts(
      first.next,
      [chatgptConnector('c1', { primary: 50, secondary: 95 })],
      90
    );
    expect(second.events).toEqual([]);
  });

  it('re-arms after the window dips below the threshold', () => {
    let state = detectUsageAlerts(
      EMPTY_USAGE_ALERT_STATE,
      [chatgptConnector('c1', { primary: 91 })],
      90
    ).next;
    state = detectUsageAlerts(state, [chatgptConnector('c1', { primary: 10 })], 90).next;

    const { events } = detectUsageAlerts(state, [chatgptConnector('c1', { primary: 93 })], 90);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'threshold', usedPercent: 93 });
  });

  it('fires a reset alert when an exhausted window drops back', () => {
    const exhausted = detectUsageAlerts(
      EMPTY_USAGE_ALERT_STATE,
      [chatgptConnector('c1', { primary: 100 })],
      90
    );
    const { events } = detectUsageAlerts(
      exhausted.next,
      [chatgptConnector('c1', { primary: 0 })],
      90
    );
    expect(events).toEqual([
      {
        kind: 'reset',
        connectorId: 'c1',
        connectorName: 'name-c1',
        window: 'primary',
        usedPercent: 0,
      },
    ]);
  });

  it('does not report a reset for a non-exhausted drop', () => {
    const state = detectUsageAlerts(
      EMPTY_USAGE_ALERT_STATE,
      [chatgptConnector('c1', { primary: 80 })],
      90
    ).next;
    const { events } = detectUsageAlerts(state, [chatgptConnector('c1', { primary: 10 })], 90);
    expect(events).toEqual([]);
  });

  it('stays silent when alerts are off but keeps tracking observations', () => {
    const off = detectUsageAlerts(
      EMPTY_USAGE_ALERT_STATE,
      [chatgptConnector('c1', { primary: 95 })],
      null
    );
    expect(off.events).toEqual([]);

    // Turning alerts on later does not re-alert an unchanged high window.
    const on = detectUsageAlerts(off.next, [chatgptConnector('c1', { primary: 95 })], 90);
    expect(on.events).toEqual([]);
  });

  it('ignores connectors without usage snapshots', () => {
    const bare = { id: 'c2', name: 'bare', provider: 'openai' } as unknown as Connector;
    const { events, next } = detectUsageAlerts(EMPTY_USAGE_ALERT_STATE, [bare], 90);
    expect(events).toEqual([]);
    expect(next.size).toBe(0);
  });
});
