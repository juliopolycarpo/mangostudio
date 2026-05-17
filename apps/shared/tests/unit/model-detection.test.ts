import { describe, expect, it } from 'bun:test';
import { isImageModelId, isReasoningModel } from '../../src/utils/model-detection';

describe('isImageModelId', () => {
  it.each([
    'dall-e-2',
    'dall-e-3',
    'chatgpt-image-latest',
    'gpt-image-1',
    'gpt-image-2',
    'gpt-image-2-hd',
    'imagen-4.0-generate-001',
    'gemini-2.5-flash-image',
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

describe('isReasoningModel', () => {
  it.each([
    'o1-preview',
    'o3-mini',
    'o4',
    'gpt-5-turbo',
    'gpt-5',
    'claude-3-5-sonnet-20241022',
    'claude-sonnet-4-202505',
    'claude-opus-4-20250514',
    'gemini-2.5-flash',
    'gemini-3.0-pro',
    'deepseek-v4',
    'deepseek-r1',
    'deepseek-reasoner',
  ])('recognises %s as a reasoning model', (modelId) => {
    expect(isReasoningModel(modelId)).toBe(true);
  });

  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-opus',
    'gemini-2.0-flash',
    'deepseek-v3',
    'text-embedding-ada-002',
  ])('rejects %s as a non-reasoning model', (modelId) => {
    expect(isReasoningModel(modelId)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isReasoningModel('O1-PREVIEW')).toBe(true);
    expect(isReasoningModel('GPT-5-TURBO')).toBe(true);
    expect(isReasoningModel('DEEPSEEK-R1')).toBe(true);
  });
});
