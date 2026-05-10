/**
 * Gemini SDK client factory.
 * Creates a GoogleGenAI instance from an API key.
 */

import { GoogleGenAI } from '@google/genai';
import { getOrCreateCachedClient } from '../core/client-cache';

const clientCache = new Map<string, GoogleGenAI>();

export function createGeminiClient(apiKey: string): GoogleGenAI {
  return getOrCreateCachedClient(clientCache, apiKey, () => new GoogleGenAI({ apiKey }));
}

export function resetGeminiClientCache(): void {
  clientCache.clear();
}
