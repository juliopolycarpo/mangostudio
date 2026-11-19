import { describe, expect, it, jest } from 'bun:test';

import { QueryClient } from '@tanstack/react-query';

import { invalidateForSignal, isReadAfterSubscribe } from '@/lib/realtime/read-after-subscribe';
import type { RealtimeSignal } from '@/lib/realtime/realtime-client';

describe('isReadAfterSubscribe', () => {
  it('covers a read taken at or after the subscribe frame', () => {
    expect(isReadAfterSubscribe(100, 100)).toBe(true);
    expect(isReadAfterSubscribe(101, 100)).toBe(true);
  });

  it('does not cover a read taken before the frame', () => {
    expect(isReadAfterSubscribe(99, 100)).toBe(false);
  });

  it('does not cover a read when either time is unknown', () => {
    expect(isReadAfterSubscribe(undefined, 100)).toBe(false);
    expect(isReadAfterSubscribe(100, undefined)).toBe(false);
  });
});

describe('invalidateForSignal', () => {
  /** Seeds `fresh` with data that landed at `updatedAt` and `stale` with data from time 1. */
  function seed(updatedAt: number) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['feed', 'fresh'], 'fresh', { updatedAt });
    queryClient.setQueryData(['feed', 'stale'], 'stale', { updatedAt: 1 });
    return { queryClient };
  }

  const invalidated = (queryClient: QueryClient, name: string) =>
    queryClient.getQueryCache().find({ queryKey: ['feed', name] })?.state.isInvalidated;

  it('invalidates every matching query for an invalidate frame', async () => {
    const { queryClient } = seed(500);
    const signal: RealtimeSignal = {
      type: 'invalidate',
      message: { type: 'invalidate', topic: 'activity' },
    };

    await invalidateForSignal(queryClient, signal, { queryKey: ['feed'], refetchType: 'none' });

    expect(invalidated(queryClient, 'fresh')).toBe(true);
    expect(invalidated(queryClient, 'stale')).toBe(true);
  });

  it('skips queries read after the subscribe frame for an ack', async () => {
    const { queryClient } = seed(500);

    await invalidateForSignal(
      queryClient,
      { type: 'subscribed', requestedAt: 400 },
      { queryKey: ['feed'], refetchType: 'none' }
    );

    expect(
      invalidated(queryClient, 'fresh'),
      '(feed/fresh): expected a read at 500 to be covered by a frame sent at 400 | received: invalidated'
    ).toBe(false);
    expect(invalidated(queryClient, 'stale')).toBe(true);
  });

  it('invalidates everything for an ack without a send time', async () => {
    const { queryClient } = seed(500);

    await invalidateForSignal(
      queryClient,
      { type: 'subscribed' },
      { queryKey: ['feed'], refetchType: 'none' }
    );

    expect(invalidated(queryClient, 'fresh')).toBe(true);
    expect(invalidated(queryClient, 'stale')).toBe(true);
  });

  it('keeps the caller predicate in force for an ack', async () => {
    const { queryClient } = seed(500);
    const onlyFresh = jest.fn(
      (query: { queryKey: readonly unknown[] }) => query.queryKey[1] === 'fresh'
    );

    await invalidateForSignal(
      queryClient,
      { type: 'subscribed', requestedAt: 900 },
      { queryKey: ['feed'], refetchType: 'none', predicate: onlyFresh }
    );

    expect(invalidated(queryClient, 'fresh')).toBe(true);
    expect(invalidated(queryClient, 'stale')).toBe(false);
  });
});
