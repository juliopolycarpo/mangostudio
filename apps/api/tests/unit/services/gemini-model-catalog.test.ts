import { describe, expect, it } from 'bun:test';
import { createGeminiModelCatalogService } from '../../../src/services/gemini';
import { createMockModel } from '../../support/mocks/mock-gemini-client';

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

    await service.refreshGeminiModelCatalog('manual');

    const snapshot = service.getGeminiModelCatalog();
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

    await service.refreshGeminiModelCatalog('manual');

    const snapshot = service.getGeminiModelCatalog();
    expect(snapshot.textModels.map((model) => model.modelId)).toEqual(['gemini-2.5-pro']);
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

    await service.refreshGeminiModelCatalog('manual');

    const snapshot = service.getGeminiModelCatalog();
    expect(snapshot.imageModels.map((model) => model.modelId)).toEqual([
      'gemini-2.5-flash-image',
      'imagen-4.0-generate-001',
    ]);
  });

  it('returns idle and empty arrays when no API key is configured', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => '',
      listModels: async () => {
        throw new Error('should not list models');
      },
    });

    const snapshot = await service.refreshGeminiModelCatalog('manual');

    expect(snapshot.configured).toBe(false);
    expect(snapshot.status).toBe('idle');
    expect(snapshot.allModels).toEqual([]);
    expect(snapshot.textModels).toEqual([]);
    expect(snapshot.imageModels).toEqual([]);
  });

  it('clears the cache after clearGeminiModelCatalog()', async () => {
    const service = createGeminiModelCatalogService({
      getApiKey: async () => 'test-key',
      listModels: async () => [createMockModel({})],
    });

    await service.refreshGeminiModelCatalog('manual');
    const clearedSnapshot = service.clearGeminiModelCatalog();

    expect(clearedSnapshot.configured).toBe(false);
    expect(clearedSnapshot.status).toBe('idle');
    expect(clearedSnapshot.allModels).toEqual([]);
    expect(clearedSnapshot.textModels).toEqual([]);
    expect(clearedSnapshot.imageModels).toEqual([]);
  });
});
