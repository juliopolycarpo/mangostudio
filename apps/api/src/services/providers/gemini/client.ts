/**
 * Gemini SDK client factory.
 * Creates a GoogleGenAI instance from an API key.
 */

import { GoogleGenAI } from '@google/genai/web';
import { getOrCreateCachedClient } from '../core/client-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';

const clientCache = new Map<string, GoogleGenAI>();

/** Creates or reuses an API-key client. Example: createGeminiClient(resolvedApiKey). */
export function createGeminiClient(apiKey: string): GoogleGenAI {
  return getOrCreateCachedClient(clientCache, apiKey, () => new GoogleGenAI({ apiKey }), {
    onHit: () => recordProviderCacheHit('gemini', 'sdk-client'),
    onMiss: () => recordProviderCacheMiss('gemini', 'sdk-client'),
  });
}

/** Drops cached clients after credentials change. Example: resetGeminiClientCache(). */
export function resetGeminiClientCache(): void {
  clientCache.clear();
}
