import { createDeepSeek, type DeepSeekProvider } from '@ai-sdk/deepseek';
import OpenAI from 'openai';
import { getOrCreateCachedClient } from '../core/client-cache';
import { validateBaseUrl } from '../core/base-url-policy';
import { fetchDeepSeekModels } from './model-catalog';
import { normalizeDeepSeekBaseUrl } from './options';

const VALIDATION_TIMEOUT_MS = 5_000;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const providerClientCache = new Map<string, DeepSeekProvider>();
const agentClientCache = new Map<string, OpenAI>();

export interface DeepSeekClientConfig {
  apiKey: string;
  baseUrl: string;
}

function createCacheKey(config: DeepSeekClientConfig): string {
  return `${normalizeDeepSeekBaseUrl(config.baseUrl)}\u0000${config.apiKey}`;
}

export function createDeepSeekClient(config: DeepSeekClientConfig): DeepSeekProvider {
  const baseUrl = normalizeDeepSeekBaseUrl(config.baseUrl);
  return getOrCreateCachedClient(providerClientCache, createCacheKey(config), () =>
    createDeepSeek({ apiKey: config.apiKey, baseURL: baseUrl })
  );
}

export function createDeepSeekAgentClient(config: DeepSeekClientConfig): OpenAI {
  const baseUrl = normalizeDeepSeekBaseUrl(config.baseUrl);
  return getOrCreateCachedClient(
    agentClientCache,
    createCacheKey(config),
    () =>
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: baseUrl,
      })
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    await fetchDeepSeekModels({
      apiKey: params.apiKey,
      baseUrl,
      fetchImpl: params.fetchImpl,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DeepSeekValidationError(`DeepSeek API key validation timed out for ${baseUrl}.`, {
        cause: error,
      });
    }
    throw new DeepSeekValidationError(`DeepSeek API key validation failed for ${baseUrl}.`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export class DeepSeekValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeepSeekValidationError';
  }
}
