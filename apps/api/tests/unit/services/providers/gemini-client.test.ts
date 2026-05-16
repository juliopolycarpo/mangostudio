import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  getProviderObservabilityMetrics,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';
import {
  createGeminiClient,
  resetGeminiClientCache,
} from '../../../../src/services/providers/gemini/client';

afterEach(() => {
  resetGeminiClientCache();
  resetProviderObservability();
});

beforeEach(() => {
  resetGeminiClientCache();
  resetProviderObservability();
});

describe('createGeminiClient', () => {
  it('reuses the same client for the same API key', () => {
    const clientA = createGeminiClient('gemini-cache-key');
    const clientB = createGeminiClient('gemini-cache-key');

    expect(clientA).toBe(clientB);
    expect(
      getProviderObservabilityMetrics().providers[0]?.caches.find(
        (entry) => entry.cacheName === 'sdk-client'
      )
    ).toMatchObject({ hits: 1, misses: 1 });
  });

  it('creates a different client when the API key changes', () => {
    const clientA = createGeminiClient('gemini-cache-key-a');
    const clientB = createGeminiClient('gemini-cache-key-b');

    expect(clientA).not.toBe(clientB);
  });
});
