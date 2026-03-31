import { describe, expect, it } from 'bun:test';
import { withModelCache } from '../../../../src/services/providers/model-cache';

describe('withModelCache', () => {
  it('invalidates a cached user entry and refetches models', async () => {
    let calls = 0;

    const cachedFetch = withModelCache(
      async (userId: string) => {
        calls += 1;
        return [{ modelId: `${userId}-${calls}` }];
      },
      { ttl: 60_000, fallback: [] }
    );

    const first = await cachedFetch('user-1');
    const second = await cachedFetch('user-1');

    expect(first).toEqual([{ modelId: 'user-1-1' }]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    cachedFetch.invalidate('user-1');

    const refreshed = await cachedFetch('user-1');

    expect(refreshed).toEqual([{ modelId: 'user-1-2' }]);
    expect(calls).toBe(2);
  });
});
