import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { RealtimeSignal, RealtimeTopicListener } from '@/lib/realtime/realtime-client';
import { act, renderHook } from '../../../support/harness/render';
import { setTestSession } from '../../../support/setup/auth-client-stub';

interface Subscription {
  topic: string;
  listener: RealtimeTopicListener;
  release: ReturnType<typeof jest.fn>;
}

// `vi.hoisted` existed because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so a plain const is enough.
const mocks = {
  bindRealtimeClientToUser: jest.fn(),
  subscribe: jest.fn(),
};

// The seam is the client module, not the WebSocket global.
mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: mocks.bindRealtimeClientToUser,
  getRealtimeClient: () => ({ subscribe: mocks.subscribe }),
}));

// Static imports run before the mock above, so the hook comes in afterwards or
// it binds the real realtime client.
const { useRealtimeInvalidation } = await import('@/lib/realtime/use-realtime-invalidation');

describe('useRealtimeInvalidation', () => {
  let subscriptions: Subscription[] = [];

  beforeEach(() => {
    // Vitest re-mocked `@/lib/auth-client` here. That module is a resolver
    // alias to the shared stub under `bun test`; the session goes in through
    // its seam and `bun.setup.ts` clears it after every test.
    setTestSession({ user: { id: 'user-test' } });
    subscriptions = [];
    mocks.subscribe.mockImplementation((topic: string, listener: RealtimeTopicListener) => {
      const release = jest.fn();
      subscriptions.push({ topic, listener, release });
      return release;
    });
    mocks.subscribe.mockClear();
    mocks.bindRealtimeClientToUser.mockClear();
  });

  function only(): Subscription {
    expect(subscriptions).toHaveLength(1);
    const subscription = subscriptions[0];
    if (!subscription) throw new Error('No subscription was recorded');
    return subscription;
  }

  it('subscribes once on mount', () => {
    renderHook(() => useRealtimeInvalidation('settings', jest.fn()));

    expect(mocks.bindRealtimeClientToUser).toHaveBeenCalledWith('user-test');
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(only().topic).toBe('settings');
  });

  it('never subscribes for a null topic', () => {
    renderHook(() => useRealtimeInvalidation(null, jest.fn()));

    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useRealtimeInvalidation('settings', jest.fn()));
    const subscription = only();
    expect(subscription.release).not.toHaveBeenCalled();

    unmount();
    expect(subscription.release).toHaveBeenCalledTimes(1);
  });

  it('swaps subscriptions when the topic changes', () => {
    const { rerender } = renderHook(
      ({ topic }: { topic: string | null }) => useRealtimeInvalidation(topic, jest.fn()),
      { initialProps: { topic: 'git:chat-1' as string | null } }
    );
    rerender({ topic: 'git:chat-2' });

    expect(subscriptions.map((subscription) => subscription.topic)).toEqual([
      'git:chat-1',
      'git:chat-2',
    ]);
    expect(subscriptions[0]?.release).toHaveBeenCalledTimes(1);
    expect(subscriptions[1]?.release).not.toHaveBeenCalled();
  });

  it('releases when the topic becomes null', () => {
    const { rerender } = renderHook(
      ({ topic }: { topic: string | null }) => useRealtimeInvalidation(topic, jest.fn()),
      { initialProps: { topic: 'git:chat-1' as string | null } }
    );
    rerender({ topic: null });

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(only().release).toHaveBeenCalledTimes(1);
  });

  it('keeps one subscription across rerenders with fresh inline callbacks', () => {
    const calls: string[] = [];

    const { rerender } = renderHook(
      ({ label }: { label: string }) =>
        useRealtimeInvalidation('settings', () => {
          calls.push(label);
        }),
      { initialProps: { label: 'render-0' } }
    );
    for (const label of ['render-1', 'render-2', 'render-3', 'render-4']) {
      rerender({ label });
    }

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    // The ref is reassigned during render, so the signal reaches the newest
    // closure rather than the one captured at subscribe time.
    act(() => {
      void only().listener({ type: 'subscribed' });
    });
    expect(calls).toEqual(['render-4']);
  });

  it('forwards both signal shapes', () => {
    const received: RealtimeSignal[] = [];

    renderHook(() =>
      useRealtimeInvalidation('settings', (signal) => {
        received.push(signal);
      })
    );

    const invalidate: RealtimeSignal = {
      type: 'invalidate',
      message: { type: 'invalidate', topic: 'settings', scopes: ['provider'] },
    };
    act(() => {
      void only().listener({ type: 'subscribed' });
      void only().listener(invalidate);
    });

    expect(received).toEqual([{ type: 'subscribed' }, invalidate]);
  });

  it('hands a rejected callback promise back to the client', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    renderHook(() =>
      useRealtimeInvalidation('settings', () => Promise.reject(new Error('invalidation failed')))
    );

    // Returning the promise is what lets the client absorb the rejection instead
    // of the hook stranding it in a floating promise of its own.
    const result = only().listener({ type: 'subscribed' });
    await expect(result).rejects.toThrow('invalidation failed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
