import { describe, expect, it } from 'bun:test';
import { withModelCache } from '../../../../src/services/providers/model-cache';

describe('withModelCache eviction', () => {
  it('evicts the oldest entry when maxEntries is exceeded', async () => {
    const maxEntries = 3;
    const fetchCounts = new Map<string, number>();

    const cachedFetch = withModelCache(
      (userId: string) => {
        fetchCounts.set(userId, (fetchCounts.get(userId) ?? 0) + 1);
        return Promise.resolve([{ userId }] as any[]);
      },
      { ttl: 60_000, fallback: [], maxEntries }
    );

    // Fill cache to max
    await cachedFetch('user-1');
    await cachedFetch('user-2');
    await cachedFetch('user-3');

    // Each user fetched exactly once so far
    expect(fetchCounts.get('user-1')).toBe(1);
    expect(fetchCounts.get('user-2')).toBe(1);
    expect(fetchCounts.get('user-3')).toBe(1);

    // Adding a 4th entry evicts user-1 (oldest)
    await cachedFetch('user-4');

    // user-1 was evicted — next access must re-fetch
    await cachedFetch('user-1');
    expect(fetchCounts.get('user-1')).toBe(2);
  });

  it('does not evict when cache size is within limit', async () => {
    const fetchCounts = new Map<string, number>();

    const cachedFetch = withModelCache(
      (userId: string) => {
        fetchCounts.set(userId, (fetchCounts.get(userId) ?? 0) + 1);
        return Promise.resolve([] as any[]);
      },
      { ttl: 60_000, fallback: [], maxEntries: 10 }
    );

    await cachedFetch('user-a');
    await cachedFetch('user-b');

    // Second access should hit cache, no new calls
    await cachedFetch('user-a');
    await cachedFetch('user-b');

    expect(fetchCounts.get('user-a')).toBe(1);
    expect(fetchCounts.get('user-b')).toBe(1);
  });
});
