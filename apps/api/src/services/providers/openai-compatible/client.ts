/**
 * OpenAI-compatible SDK client factory.
 * Creates an OpenAI client pointed at a custom base URL.
 */

import OpenAI from 'openai';
import { getOrCreateCachedClient } from '../core/client-cache';

const clientCache = new Map<string, OpenAI>();

export function createCompatibleClient(apiKey: string, baseUrl: string): OpenAI {
  return getOrCreateCachedClient(
    clientCache,
    `${baseUrl}\u0000${apiKey}`,
    () => new OpenAI({ apiKey, baseURL: baseUrl })
  );
}
