import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { GoogleGenAI } from '@google/genai/web';

import {
  getProviderObservabilityMetrics,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';
import {
  createGeminiClient,
  resetGeminiClientCache,
} from '../../../../src/services/providers/gemini/client';

const realFetch = globalThis.fetch;

/** Named fake for the SDK's global fetch: records each URL and answers an empty model list. */
class RecordingModelListFetch {
  readonly urls: string[] = [];

  readonly fetch = (input: string | URL | Request): Promise<Response> => {
    this.urls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ models: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    );
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
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

    expect(clientA).toBeInstanceOf(GoogleGenAI);
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

  it('creates a fresh client after resetting the cache', () => {
    const previous = createGeminiClient('gemini-reset-key');
    resetGeminiClientCache();
    expect(createGeminiClient('gemini-reset-key')).not.toBe(previous);
  });

  it('calls the v1beta endpoints, not the v1 default of @google/genai 3', async () => {
    const recorder = new RecordingModelListFetch();
    globalThis.fetch = recorder.fetch as typeof fetch;

    await createGeminiClient('gemini-version-key').models.list();

    expect(recorder.urls.map((url) => new URL(url).pathname)).toEqual(['/v1beta/models']);
  });
});
