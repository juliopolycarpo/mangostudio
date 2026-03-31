import { describe, expect, it } from 'bun:test';
import {
  createGeminiModelCatalogService,
  GeminiApiKeyMissingError,
} from '../../../src/services/gemini';
import { createMockModel } from '../../support/mocks/mock-gemini-client';

const TEST_USER = 'test-user';

describe('createGeminiModelCatalogService', () => {
  it('normalizes discovered Gemini models into UI-safe options', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => [
        createMockModel({
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
        }),
      ],
    });

    await service.refreshGeminiModelCatalog(TEST_USER, 'manual');

    const snapshot = await service.getGeminiModelCatalog(TEST_USER);
    expect(snapshot.status).toBe('ready');
    expect(snapshot.allModels).toHaveLength(1);
    expect(snapshot.allModels[0]?.modelId).toBe('gemini-2.5-flash');
    expect(snapshot.allModels[0]?.resourceName).toBe('models/gemini-2.5-flash');
    expect(snapshot.allModels[0]?.displayName).toBe('Gemini 2.5 Flash');
  });

  it('filters text models by generateContent support', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => [
        createMockModel({
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          supportedActions: ['generateContent'],
        }),
        createMockModel({
          name: 'models/gemini-embedding-001',
          displayName: 'Gemini Embedding',
          supportedActions: ['embedContent'],
        }),
        createMockModel({
          name: 'models/gemini-2.5-flash-image',
          displayName: 'Gemini 2.5 Flash Image',
          supportedActions: ['generateContent'],
        }),
      ],
    });

    await service.refreshGeminiModelCatalog(TEST_USER, 'manual');

    const snapshot = await service.getGeminiModelCatalog(TEST_USER);
    expect(snapshot.discoveredTextModels.map((model) => model.modelId)).toEqual(['gemini-2.5-pro']);
  });

  it('filters image models conservatively by modelId family', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => [
        createMockModel({
          name: 'models/gemini-2.5-flash-image',
          displayName: 'Gemini 2.5 Flash Image',
          supportedActions: ['generateContent'],
        }),
        createMockModel({
          name: 'models/imagen-4.0-generate-001',
          displayName: 'Imagen 4',
          supportedActions: ['predict'],
        }),
        createMockModel({
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          supportedActions: ['generateContent'],
        }),
      ],
    });

    await service.refreshGeminiModelCatalog(TEST_USER, 'manual');

    const snapshot = await service.getGeminiModelCatalog(TEST_USER);
    expect(snapshot.discoveredImageModels.map((model) => model.modelId)).toEqual([
      'gemini-2.5-flash-image',
      'imagen-4.0-generate-001',
    ]);
  });

  it('returns idle and empty arrays when no API key is configured', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => {
        throw new GeminiApiKeyMissingError();
      },
      listModels: async () => {
        throw new Error('should not list models');
      },
    });

    const snapshot = await service.refreshGeminiModelCatalog(TEST_USER, 'manual');

    expect(snapshot.configured).toBe(false);
    expect(snapshot.status).toBe('idle');
    expect(snapshot.allModels).toEqual([]);
    expect(snapshot.textModels).toEqual([]);
    expect(snapshot.imageModels).toEqual([]);
  });

  it('awaits first refresh on cold start and returns discovered models', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => [
        createMockModel({
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedActions: ['generateContent'],
        }),
        createMockModel({
          name: 'models/gemini-2.5-flash-image',
          displayName: 'Gemini 2.5 Flash Image',
          supportedActions: ['generateContent'],
        }),
      ],
    });

    // First call should await refresh, NOT return empty
    const snapshot = await service.getGeminiModelCatalog(TEST_USER);

    expect(snapshot.status).toBe('ready');
    expect(snapshot.allModels.length).toBeGreaterThan(0);
    expect(snapshot.discoveredTextModels.map((m) => m.modelId)).toContain('gemini-2.5-flash');
    expect(snapshot.discoveredImageModels.map((m) => m.modelId)).toContain('gemini-2.5-flash-image');
  });

  it('returns cached models on subsequent calls without re-fetching', async () => {
    let fetchCount = 0;
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => {
        fetchCount++;
        return [
          createMockModel({
            name: 'models/gemini-2.5-pro',
            supportedActions: ['generateContent'],
          }),
        ];
      },
    });

    await service.getGeminiModelCatalog(TEST_USER);
    await service.getGeminiModelCatalog(TEST_USER);

    // Only one API call should have been made
    expect(fetchCount).toBe(1);
  });

  it('clears the cache after clearGeminiModelCatalog()', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => [createMockModel({})],
    });

    await service.refreshGeminiModelCatalog(TEST_USER, 'manual');
    const clearedSnapshot = service.clearGeminiModelCatalog(TEST_USER);

    expect(clearedSnapshot.configured).toBe(false);
    expect(clearedSnapshot.status).toBe('idle');
    expect(clearedSnapshot.allModels).toEqual([]);
    expect(clearedSnapshot.textModels).toEqual([]);
    expect(clearedSnapshot.imageModels).toEqual([]);
  });
});
