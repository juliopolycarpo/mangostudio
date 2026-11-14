/**
 * Gemini SDK client factory.
 * Creates a GoogleGenAI instance from an API key.
 */

import { GoogleGenAI } from '@google/genai/web';

import { getOrCreateCachedClient } from '../core/client-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';

const clientCache = new Map<string, GoogleGenAI>();

/**
 * `@google/genai` 3.0 defaults the Gemini Developer API to `v1`, which lacks the
 * `*-latest` model aliases and the Interactions endpoint this provider relies on.
 * Pin `v1beta`, the 2.x default, so the wire contract does not move with the SDK.
 */
export const GEMINI_API_VERSION = 'v1beta';

/** Creates or reuses an API-key client. Example: createGeminiClient(resolvedApiKey). */
export function createGeminiClient(apiKey: string): GoogleGenAI {
  return getOrCreateCachedClient(
    clientCache,
    apiKey,
    () => new GoogleGenAI({ apiKey, apiVersion: GEMINI_API_VERSION }),
    {
      onHit: () => recordProviderCacheHit('gemini', 'sdk-client'),
      onMiss: () => recordProviderCacheMiss('gemini', 'sdk-client'),
    }
  );
}

/** Drops cached clients after credentials change. Example: resetGeminiClientCache(). */
export function resetGeminiClientCache(): void {
  clientCache.clear();
}
