import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateCachedClient } from '../core/client-cache';

const clientCache = new Map<string, Anthropic>();

export function createAnthropicClient(apiKey: string): Anthropic {
  return getOrCreateCachedClient(clientCache, apiKey, () => new Anthropic({ apiKey }));
}
