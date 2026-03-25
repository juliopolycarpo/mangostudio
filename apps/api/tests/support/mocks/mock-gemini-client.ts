import type { Model } from '@google/genai';
import { MOCK_MODELS } from '@mangostudio/shared/test-utils';

/**
 * Creates a mock Gemini client with a fixed model response.
 *
 * @param models - Models returned by listModels.
 * @returns A mock Gemini client.
 */
export function createMockGeminiClient(models: Model[] = []) {
  return {
    listModels: async (): Promise<Model[]> => models,
  };
}

/**
 * Creates a mock Gemini model with sensible defaults for tests.
 *
 * @param overrides - Partial model overrides.
 * @returns A mock Gemini model payload.
 */
export function createMockModel(overrides: Partial<Model> = {}): Model {
  return {
    name: MOCK_MODELS.text.name,
    displayName: MOCK_MODELS.text.displayName,
    description: MOCK_MODELS.text.description,
    version: '2026.03',
    supportedActions: ['generateContent'],
    ...overrides,
  };
}

/**
 * Creates a normalized Gemini model catalog snapshot from mock models.
 *
 * @param models - Source models to normalize.
 * @returns A ready-to-assert catalog snapshot.
 */
export function createMockGeminiModelCatalog(models: Model[] = [createMockModel()]) {
  const allModels = models.map((model) => ({
    modelId: model.name?.split('/').pop() ?? 'unknown',
    resourceName: model.name ?? '',
    displayName: model.displayName ?? 'Unknown',
    description: model.description ?? undefined,
    version: model.version ?? undefined,
    supportedActions: model.supportedActions ?? [],
  }));

  const textModels = allModels.filter(
    (model) =>
      model.supportedActions.includes('generateContent') && !model.modelId.includes('-image')
  );
  const imageModels = allModels.filter(
    (model) => model.modelId.includes('-image') || model.modelId.startsWith('imagen-')
  );

  return {
    configured: models.length > 0,
    status: 'ready' as const,
    allModels,
    textModels,
    imageModels,
  };
}
