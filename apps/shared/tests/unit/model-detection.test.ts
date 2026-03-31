import { describe, expect, it } from 'vitest';
import { isImageModelId } from '../../src/utils/model-detection';

describe('isImageModelId', () => {
  it.each([
    'dall-e-2',
    'dall-e-3',
    'gpt-image-1',
    'gpt-image-2-hd',
    'imagen-4.0-generate-001',
    'gemini-2.0-flash-image-generation',
    'stable-diffusion-xl-1024-v1-0',
    'sdxl-turbo',
  ])('recognises %s as an image model', (modelId) => {
    expect(isImageModelId(modelId)).toBe(true);
  });

  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-opus',
    'gemini-2.0-flash',
    'text-embedding-ada-002',
    'whisper-1',
  ])('rejects %s as a non-image model', (modelId) => {
    expect(isImageModelId(modelId)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isImageModelId('DALL-E-3')).toBe(true);
    expect(isImageModelId('GPT-IMAGE-1')).toBe(true);
  });
});
