import type { Model } from '@google/genai';
import { MOCK_MODELS } from '@mangostudio/shared/test-utils';

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
