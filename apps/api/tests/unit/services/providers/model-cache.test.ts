import { describe, expect, it } from 'bun:test';
import { withModelCache } from '../../../../src/services/providers/core/model-cache';

interface HeldModel {
  modelId: string;
}

/** Named fake: every call parks on its own deferred, released by index. */
function createHeldLoader() {
  const releases: Array<(models: HeldModel[]) => void> = [];
  const load = (_userId: string): Promise<HeldModel[]> =>
    new Promise<HeldModel[]>((resolve) => {
      releases.push(resolve);
    });
  return {
    load,
    calls: () => releases.length,
    release: (index: number, models: HeldModel[]) => releases[index]?.(models),
  };
}

function expectCount(label: string, expected: number, received: number): void {
  if (expected === received) return;
  throw new Error(`expected ${label}: ${expected} | received: ${received}`);
}

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

  it('does not let a loader started before invalidate repopulate the cache', async () => {
    const held = createHeldLoader();
    const cachedFetch = withModelCache(held.load, { ttl: 60_000, fallback: [] });

    const startedBefore = cachedFetch('user-1');
    cachedFetch.invalidate('user-1');
    held.release(0, [{ modelId: 'old' }]);

    // The already-started caller still receives its own answer.
    expect(await startedBefore).toEqual([{ modelId: 'old' }]);

    const afterInvalidation = cachedFetch('user-1');
    expectCount('loader calls after invalidation', 2, held.calls());
    held.release(1, [{ modelId: 'new' }]);
    expect(await afterInvalidation).toEqual([{ modelId: 'new' }]);
  });

  it('does not let a full invalidate() cache a loader that was in flight', async () => {
    const held = createHeldLoader();
    const cachedFetch = withModelCache(held.load, { ttl: 60_000, fallback: [] });

    const startedBefore = cachedFetch('user-1');
    cachedFetch.invalidate();
    held.release(0, [{ modelId: 'old' }]);
    await startedBefore;

    const afterInvalidation = cachedFetch('user-1');
    expectCount('loader calls after invalidation', 2, held.calls());
    held.release(1, [{ modelId: 'new' }]);
    expect(await afterInvalidation).toEqual([{ modelId: 'new' }]);
  });

  it('keeps the replacement loader joinable when an invalidated loader settles', async () => {
    const held = createHeldLoader();
    const cachedFetch = withModelCache(held.load, { ttl: 60_000, fallback: [] });

    const invalidated = cachedFetch('user-1');
    cachedFetch.invalidate('user-1');
    const replacement = cachedFetch('user-1');
    expectCount('loader calls before the old loader settles', 2, held.calls());

    held.release(0, [{ modelId: 'old' }]);
    await invalidated;

    const joiner = cachedFetch('user-1');
    expectCount('third-loader calls', 0, held.calls() - 2);

    held.release(1, [{ modelId: 'new' }]);
    expect(await replacement).toEqual([{ modelId: 'new' }]);
    expect(await joiner).toEqual([{ modelId: 'new' }]);
  });

  it('does not let an invalidated loader write after its replacement already settled', async () => {
    const held = createHeldLoader();
    const cachedFetch = withModelCache(held.load, { ttl: 60_000, fallback: [] });

    const invalidated = cachedFetch('user-1');
    cachedFetch.invalidate('user-1');
    const replacement = cachedFetch('user-1');

    // The replacement settles first and caches; its in-flight entry is gone.
    held.release(1, [{ modelId: 'new' }]);
    expect(await replacement).toEqual([{ modelId: 'new' }]);

    // The old loader now settles with no in-flight entry left to compare against.
    held.release(0, [{ modelId: 'old' }]);
    expect(await invalidated).toEqual([{ modelId: 'old' }]);

    expect(await cachedFetch('user-1')).toEqual([{ modelId: 'new' }]);
    expectCount('loader calls after both loaders settled', 2, held.calls());
  });
});
