import { describe, expect, it } from 'bun:test';
import { withModelCache } from '../../../../src/services/providers/core/model-cache';

describe('withModelCache', () => {
  it('invalidates a cached user entry and refetches models', async () => {
    let calls = 0;

    const cachedFetch = withModelCache(
      (userId: string) => {
        calls += 1;
        return Promise.resolve([{ modelId: `${userId}-${calls}` }]);
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

  it('returns the fallback when the first fetch fails', async () => {
    const fallback = [{ modelId: 'fallback-model' }];

    const cachedFetch = withModelCache(() => Promise.reject(new Error('model discovery failed')), {
      ttl: 60_000,
      fallback,
    });

    const models = await cachedFetch('user-1');

    expect(models).toEqual(fallback);
  });

  it('returns stale cached models when a refresh fails after ttl expiry', async () => {
    let now = 0;
    let shouldFail = false;

    const cachedFetch = withModelCache(
      () => {
        if (shouldFail) {
          return Promise.reject(new Error('refresh failed'));
        }

        return Promise.resolve([{ modelId: 'cached-model' }]);
      },
      {
        ttl: 10,
        fallback: [{ modelId: 'fallback-model' }],
        now: () => now,
      }
    );

    expect(await cachedFetch('user-1')).toEqual([{ modelId: 'cached-model' }]);

    now = 11;
    shouldFail = true;

    expect(await cachedFetch('user-1')).toEqual([{ modelId: 'cached-model' }]);
  });
});
