import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { createUnifiedModelCatalogService } from '../../../../src/services/providers/catalog';
import type { AIProvider } from '../../../../src/services/providers/types';

const MOCK_MODEL = {
  modelId: 'gemini-2.0-flash',
  displayName: 'Gemini 2.0 Flash',
  provider: 'gemini' as const,
  capabilities: { text: true, image: false, streaming: true },
};

/** Builds a service instance with injected test doubles — no module mocking needed. */
function makeService(
  modelList: (typeof MOCK_MODEL)[] = [MOCK_MODEL],
  enabledIds: string[] = [MOCK_MODEL.modelId]
) {
  return createUnifiedModelCatalogService({
    listProviders: () => ['gemini'],
    getProviderFn: () =>
      ({ listModels: () => Promise.resolve(modelList) }) as unknown as AIProvider,
    listAllSecretMetadataFn: () =>
      Promise.resolve([
        { enabledModels: JSON.stringify(enabledIds) },
      ] as unknown as SecretMetadataRow[]),
  });
}

describe('createUnifiedModelCatalogService.getUnifiedModelCatalog', () => {
  it('awaits refresh on cold cache and returns ready status', async () => {
    const service = makeService();
    const result = await service.getUnifiedModelCatalog('user-cold');

    expect(result.status).toBe('ready');
    expect(result.configured).toBe(true);
    expect(result.allModels.length).toBeGreaterThan(0);
  });

  it('does not trigger an extra refresh call on warm cache', async () => {
    let callCount = 0;

    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () =>
        ({
          listModels: () => {
            callCount++;
            return Promise.resolve([MOCK_MODEL]);
          },
        }) as unknown as AIProvider,
      listAllSecretMetadataFn: () =>
        Promise.resolve([
          { enabledModels: JSON.stringify([MOCK_MODEL.modelId]) },
        ] as unknown as SecretMetadataRow[]),
    });

    // First call — cold cache, triggers refresh (listModels called once)
    await service.getUnifiedModelCatalog('user-warm');
    const countAfterFirst = callCount;

    // Second call — warm cache, must NOT trigger another refresh
    const result = await service.getUnifiedModelCatalog('user-warm');

    expect(result.status).toBe('ready');
    expect(callCount).toBe(countAfterFirst);
  });

  it('reuses the warm snapshot without re-reading enabled models', async () => {
    let providerCallCount = 0;
    let metadataCallCount = 0;

    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () =>
        ({
          listModels: () => {
            providerCallCount++;
            return Promise.resolve([MOCK_MODEL]);
          },
        }) as unknown as AIProvider,
      listAllSecretMetadataFn: () => {
        metadataCallCount++;
        return Promise.resolve([
          { enabledModels: JSON.stringify([MOCK_MODEL.modelId]) },
        ] as unknown as SecretMetadataRow[]);
      },
    });

    await service.getUnifiedModelCatalog('user-snapshot-cache');
    await service.getUnifiedModelCatalog('user-snapshot-cache');

    expect(providerCallCount).toBe(1);
    expect(metadataCallCount).toBe(1);
  });

  it('recalculates a dirty snapshot without re-fetching provider models', async () => {
    let providerCallCount = 0;
    let metadataCallCount = 0;
    let enabledModels = [MOCK_MODEL.modelId];

    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () =>
        ({
          listModels: () => {
            providerCallCount++;
            return Promise.resolve([MOCK_MODEL]);
          },
        }) as unknown as AIProvider,
      listAllSecretMetadataFn: () => {
        metadataCallCount++;
        return Promise.resolve([
          { enabledModels: JSON.stringify(enabledModels) },
        ] as unknown as SecretMetadataRow[]);
      },
    });

    await service.getUnifiedModelCatalog('user-dirty-snapshot');
    enabledModels = [];
    service.recalculate('user-dirty-snapshot');

    const result = await service.getUnifiedModelCatalog('user-dirty-snapshot');

    expect(providerCallCount).toBe(1);
    expect(metadataCallCount).toBe(2);
    expect(result.textModels).toEqual([]);
  });

  it('refreshes stale provider discovery in the background', async () => {
    let currentTime = 0;
    let providerCallCount = 0;

    const service = createUnifiedModelCatalogService({
      now: () => currentTime,
      listProviders: () => ['gemini'],
      getProviderFn: () =>
        ({
          listModels: () => {
            providerCallCount++;
            return Promise.resolve([MOCK_MODEL]);
          },
        }) as unknown as AIProvider,
      listAllSecretMetadataFn: () =>
        Promise.resolve([
          { enabledModels: JSON.stringify([MOCK_MODEL.modelId]) },
        ] as unknown as SecretMetadataRow[]),
    });

    await service.getUnifiedModelCatalog('user-stale-refresh');
    currentTime = 60 * 60 * 1000 + 1;

    const result = await service.getUnifiedModelCatalog('user-stale-refresh');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe('ready');
    expect(providerCallCount).toBe(2);
  });

  it('returns cached capabilities without refreshing a cold cache', async () => {
    let callCount = 0;

    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () =>
        ({
          listModels: () => {
            callCount++;
            return Promise.resolve([MOCK_MODEL]);
          },
        }) as unknown as AIProvider,
      listAllSecretMetadataFn: () =>
        Promise.resolve([
          { enabledModels: JSON.stringify([MOCK_MODEL.modelId]) },
        ] as unknown as SecretMetadataRow[]),
    });

    const coldCapabilities = service.getCachedModelCapabilities(
      'user-cache-only',
      MOCK_MODEL.modelId
    );

    expect(coldCapabilities).toBeUndefined();
    expect(callCount).toBe(0);

    await service.getUnifiedModelCatalog('user-cache-only');

    const warmCapabilities = service.getCachedModelCapabilities(
      'user-cache-only',
      MOCK_MODEL.modelId
    );

    expect(warmCapabilities).toEqual(MOCK_MODEL.capabilities);
    expect(callCount).toBe(1);
  });

  it('returns cached provider metadata after the catalog is warm', async () => {
    const service = makeService();

    expect(service.getCachedModelMetadata('user-metadata', MOCK_MODEL.modelId)).toBeUndefined();

    await service.getUnifiedModelCatalog('user-metadata');

    expect(service.getCachedModelMetadata('user-metadata', MOCK_MODEL.modelId)).toEqual({
      providerType: 'gemini',
      capabilities: MOCK_MODEL.capabilities,
    });
  });

  it('resolves even when all providers fail', async () => {
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () =>
        ({
          listModels: () => Promise.reject(new Error('provider unavailable')),
        }) as unknown as AIProvider,
      listAllSecretMetadataFn: () => Promise.resolve([] as SecretMetadataRow[]),
    });

    const result = await service.getUnifiedModelCatalog('user-error');

    // allSettled swallows individual provider errors; snapshot should still resolve
    expect(['ready', 'error']).toContain(result.status);
  });
});
