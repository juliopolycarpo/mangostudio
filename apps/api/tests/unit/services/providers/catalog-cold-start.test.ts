import { describe, expect, it } from 'bun:test';
import { createUnifiedModelCatalogService } from '../../../../src/services/providers/catalog';
import type { ProviderType } from '@mangostudio/shared/types';

const MOCK_MODEL = {
  modelId: 'gemini-2.0-flash',
  displayName: 'Gemini 2.0 Flash',
  provider: 'gemini' as const,
  capabilities: { text: true, image: false, streaming: true },
};

/** Builds a service instance with injected test doubles — no module mocking needed. */
function makeService(modelList: typeof MOCK_MODEL[] = [MOCK_MODEL], enabledIds: string[] = [MOCK_MODEL.modelId]) {
  return createUnifiedModelCatalogService({
    listProviders: () => ['gemini' as ProviderType],
    getProviderFn: () => ({ listModels: async () => modelList } as any),
    listAllSecretMetadataFn: async () =>
      [{ enabledModels: JSON.stringify(enabledIds) }] as any,
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
      listProviders: () => ['gemini' as ProviderType],
      getProviderFn: () => ({
        listModels: async () => {
          callCount++;
          return [MOCK_MODEL];
        },
      } as any),
      listAllSecretMetadataFn: async () =>
        [{ enabledModels: JSON.stringify([MOCK_MODEL.modelId]) }] as any,
    });

    // First call — cold cache, triggers refresh (listModels called once)
    await service.getUnifiedModelCatalog('user-warm');
    const countAfterFirst = callCount;

    // Second call — warm cache, must NOT trigger another refresh
    const result = await service.getUnifiedModelCatalog('user-warm');

    expect(result.status).toBe('ready');
    expect(callCount).toBe(countAfterFirst);
  });

  it('resolves even when all providers fail', async () => {
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini' as ProviderType],
      getProviderFn: () => ({
        listModels: async () => { throw new Error('provider unavailable'); },
      } as any),
      listAllSecretMetadataFn: async () => [] as any,
    });

    const result = await service.getUnifiedModelCatalog('user-error');

    // allSettled swallows individual provider errors; snapshot should still resolve
    expect(['ready', 'error']).toContain(result.status);
  });
});
