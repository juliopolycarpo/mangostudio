import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateCachedClient } from '../core/client-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';

const clientCache = new Map<string, Anthropic>();

export function createAnthropicClient(apiKey: string): Anthropic {
  return getOrCreateCachedClient(clientCache, apiKey, () => new Anthropic({ apiKey }), {
    onHit: () => recordProviderCacheHit('anthropic', 'sdk-client'),
    onMiss: () => recordProviderCacheMiss('anthropic', 'sdk-client'),
  });
}
