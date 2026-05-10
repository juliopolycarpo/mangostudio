import { afterEach, describe, expect, it } from 'bun:test';
import {
  createGeminiClient,
  resetGeminiClientCache,
} from '../../../../src/services/providers/gemini/client';

afterEach(() => {
  resetGeminiClientCache();
});

describe('createGeminiClient', () => {
  it('reuses the same client for the same API key', () => {
    const clientA = createGeminiClient('gemini-cache-key');
    const clientB = createGeminiClient('gemini-cache-key');

    expect(clientA).toBe(clientB);
  });

  it('creates a different client when the API key changes', () => {
    const clientA = createGeminiClient('gemini-cache-key-a');
    const clientB = createGeminiClient('gemini-cache-key-b');

    expect(clientA).not.toBe(clientB);
  });
});
