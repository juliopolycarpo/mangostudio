import { describe, expect, it, mock } from 'bun:test';

import type { RealtimeSignal } from '../../../src/lib/realtime/realtime-client';
import type { StaleBuildMonitor } from '../../../src/lib/stale-build';
import { render } from '../../support/harness/render';

type SignalHandler = (signal: RealtimeSignal) => void | Promise<void>;

/** Stands in for the realtime hook: records the subscription and lets a test deliver signals. */
const realtime = {
  topic: null as string | null,
  concern: null as string | null,
  handler: null as SignalHandler | null,
};

function recordRealtimeSubscription(
  topic: string | null,
  concern: string,
  onSignal: SignalHandler
) {
  realtime.topic = topic;
  realtime.concern = concern;
  realtime.handler = onSignal;
}

void mock.module('../../../src/lib/realtime/use-realtime-invalidation', () => ({
  useRealtimeInvalidation: recordRealtimeSubscription,
}));

const { useRecheckStaleBuildWhenReachable } = await import('../../../src/hooks/use-stale-build');

function fakeMonitor() {
  const calls = { reachable: 0 };
  const monitor: StaleBuildMonitor = {
    check: () => Promise.resolve(false),
    isStale: () => false,
    subscribe: () => () => undefined,
    noteChunkLoaded: () => undefined,
    noteHubReachable: () => {
      calls.reachable += 1;
    },
  };
  return { monitor, calls };
}

function Recheck({ monitor }: { readonly monitor: StaleBuildMonitor }) {
  useRecheckStaleBuildWhenReachable(monitor);
  return null;
}

describe('useRecheckStaleBuildWhenReachable', () => {
  it('reports the hub reachable when the realtime socket acknowledges a subscription', () => {
    const { monitor, calls } = fakeMonitor();
    render(<Recheck monitor={monitor} />);

    expect(realtime.topic, 'topic the hook subscribed to').toBe('activity');
    void realtime.handler?.({ type: 'subscribed' });

    expect(calls.reachable, 'noteHubReachable calls after a subscribed ack').toBe(1);
  });

  it('ignores realtime signals that are not a subscription ack', () => {
    const { monitor, calls } = fakeMonitor();
    render(<Recheck monitor={monitor} />);

    void realtime.handler?.({
      type: 'invalidate',
      message: { type: 'invalidate', topic: 'activity' },
    } as unknown as RealtimeSignal);

    expect(calls.reachable, 'noteHubReachable calls after an invalidate signal').toBe(0);
  });

  it('reports the hub reachable when the browser comes back online, and stops after unmount', () => {
    const { monitor, calls } = fakeMonitor();
    const { unmount } = render(<Recheck monitor={monitor} />);

    window.dispatchEvent(new Event('online'));
    expect(calls.reachable, 'noteHubReachable calls after an online event').toBe(1);

    unmount();
    window.dispatchEvent(new Event('online'));
    expect(calls.reachable, 'noteHubReachable calls after unmount').toBe(1);
  });
});
