import { describe, expect, it } from 'bun:test';
import { createProviderLifecycle } from '../../../../src/services/providers/core/provider-lifecycle';

describe('createProviderLifecycle', () => {
  it('reuses warmed runtimes until the user cache is invalidated', async () => {
    let loadCount = 0;
    const invalidatedUsers: Array<string | undefined> = [];

    const lifecycle = createProviderLifecycle({
      provider: 'openai',
      loadPreparedRuntime: async (userId: string, modelName?: string) => ({
        cacheKey: `${userId}:${modelName ?? ''}`,
        loadCount: ++loadCount,
      }),
      invalidateCachedModels: (userId?: string) => {
        invalidatedUsers.push(userId);
      },
    });

    await lifecycle.warmup({ userId: 'user-1', modelName: 'model-a', purpose: 'text' });

    const warmed = await lifecycle.prepareRuntime('user-1', 'model-a');
    const cached = await lifecycle.prepareRuntime('user-1', 'model-a');

    expect(warmed).toBe(cached);
    expect(loadCount).toBe(1);

    lifecycle.invalidateModelCache('user-1');

    const refreshed = await lifecycle.prepareRuntime('user-1', 'model-a');

    expect(refreshed).not.toBe(warmed);
    expect(refreshed.loadCount).toBe(2);
    expect(invalidatedUsers).toEqual(['user-1']);
  });

  it('clears every prepared runtime when invalidated without a user id', async () => {
    let loadCount = 0;

    const lifecycle = createProviderLifecycle({
      provider: 'anthropic',
      loadPreparedRuntime: async (userId: string, modelName?: string) => ({
        cacheKey: `${userId}:${modelName ?? ''}`,
        loadCount: ++loadCount,
      }),
    });

    await lifecycle.prepareRuntime('user-1', 'model-a');
    await lifecycle.prepareRuntime('user-2', 'model-b');

    expect(loadCount).toBe(2);

    lifecycle.invalidateModelCache();

    await lifecycle.prepareRuntime('user-1', 'model-a');
    await lifecycle.prepareRuntime('user-2', 'model-b');

    expect(loadCount).toBe(4);
  });

  it('delegates connector sync when configured and no-ops otherwise', async () => {
    const syncedUsers: string[] = [];

    const withSync = createProviderLifecycle({
      provider: 'deepseek',
      loadPreparedRuntime: () => Promise.resolve({}),
      syncConfigFileConnectors: (userId: string) => {
        syncedUsers.push(userId);
        return Promise.resolve();
      },
    });

    const withoutSync = createProviderLifecycle({
      provider: 'gemini',
      loadPreparedRuntime: () => Promise.resolve({}),
    });

    await withSync.syncConfigFileConnectors('user-1');
    await expect(withoutSync.syncConfigFileConnectors('user-2')).resolves.toBeUndefined();

    expect(syncedUsers).toEqual(['user-1']);
  });
});
