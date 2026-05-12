/**
 * OpenAI-compatible SDK client factory.
 * Creates an OpenAI client pointed at a custom base URL.
 */

import OpenAI from 'openai';
import { getOrCreateCachedClient } from '../core/client-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';

const clientCache = new Map<string, OpenAI>();

interface CompatibleClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

function createCacheKey(
  apiKey: string,
  baseUrl: string,
  options?: CompatibleClientOptions
): string {
  return [
    baseUrl,
    apiKey,
    String(options?.timeoutMs ?? ''),
    String(options?.maxRetries ?? ''),
  ].join('\u0000');
}

export function createCompatibleClient(
  apiKey: string,
  baseUrl: string,
  options: CompatibleClientOptions = {}
): OpenAI {
  return getOrCreateCachedClient(
    clientCache,
    createCacheKey(apiKey, baseUrl, options),
    () =>
      new OpenAI({
        apiKey,
        baseURL: baseUrl,
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      }),
    {
      onHit: () => recordProviderCacheHit('openai-compatible', 'sdk-client'),
      onMiss: () => recordProviderCacheMiss('openai-compatible', 'sdk-client'),
    }
  );
}
