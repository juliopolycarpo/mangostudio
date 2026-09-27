import OpenAI from 'openai';
import { validateBaseUrl } from '../core/base-url-policy';
import { getOrCreateCachedClient } from '../core/client-cache';
import { withPromiseTimeout } from '../core/probe-timeout';
import {
  recordProviderCacheHit,
  recordProviderCacheMiss,
  recordProviderProbeTimeout,
} from '../core/provider-observability';
import { fetchDeepSeekModels } from './model-catalog';
import { normalizeDeepSeekBaseUrl } from './options';

const VALIDATION_TIMEOUT_MS = 5_000;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const clientCache = new Map<string, OpenAI>();

export interface DeepSeekClientConfig {
  apiKey: string;
  baseUrl: string;
}

function createCacheKey(config: DeepSeekClientConfig): string {
  return `${normalizeDeepSeekBaseUrl(config.baseUrl)}\u0000${config.apiKey}`;
}

/**
 * The OpenAI SDK client for one DeepSeek connector, shared by text and agent
 * turns and cached per base URL and key.
 *
 * // Usage: const client = createDeepSeekClient({ apiKey, baseUrl });
 */
export function createDeepSeekClient(config: DeepSeekClientConfig): OpenAI {
  const baseUrl = normalizeDeepSeekBaseUrl(config.baseUrl);
  return getOrCreateCachedClient(
    clientCache,
    createCacheKey(config),
    () =>
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: baseUrl,
      }),
    {
      onHit: () => recordProviderCacheHit('deepseek', 'sdk-client'),
      onMiss: () => recordProviderCacheMiss('deepseek', 'sdk-client'),
    }
  );
}

export async function validateDeepSeekApiKey(params: {
  apiKey: string;
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const baseUrl = normalizeDeepSeekBaseUrl(params.baseUrl);
  if (baseUrl !== normalizeDeepSeekBaseUrl(null)) {
    await validateBaseUrl(baseUrl);
  }

  try {
    await withPromiseTimeout(
      () =>
        fetchDeepSeekModels({
          apiKey: params.apiKey,
          baseUrl,
          fetchImpl: params.fetchImpl,
        }),
      `DeepSeek API key validation timed out for ${baseUrl}.`,
      VALIDATION_TIMEOUT_MS,
      () =>
        recordProviderProbeTimeout({
          provider: 'deepseek',
          operation: 'healthcheck',
          message: `DeepSeek API key validation timed out for ${baseUrl}.`,
        })
    );
  } catch (error) {
    throw new DeepSeekValidationError(
      error instanceof Error && error.message.includes('timed out')
        ? `DeepSeek API key validation timed out for ${baseUrl}.`
        : `DeepSeek API key validation failed for ${baseUrl}.`,
      { cause: error }
    );
  }
}

class DeepSeekValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeepSeekValidationError';
  }
}
