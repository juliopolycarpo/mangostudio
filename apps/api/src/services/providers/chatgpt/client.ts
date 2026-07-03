/**
 * ChatGPT backend SDK client factory.
 *
 * The ChatGPT (subscription) backend speaks the Responses protocol, so the
 * standard OpenAI SDK is reused with the backend base URL, the OAuth access
 * token as the bearer key, and the account/beta/originator headers the
 * backend requires on every request.
 */

import OpenAI from 'openai';
import { getConfig } from '../../../lib/config';
import type { ChatGptTokenBundle } from '../../../modules/connectors/infrastructure/chatgpt/oauth-client';
import { getOrCreateCachedClient } from '../core/client-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';
import { captureChatGptUsageHeaders } from './usage';

const clientCache = new Map<string, OpenAI>();

/**
 * Creates (or reuses) an SDK client for a token bundle. The cache key includes
 * the access token, so token rotation naturally invalidates stale clients.
 */
export function createChatGptClient(bundle: ChatGptTokenBundle): OpenAI {
  const baseURL = getConfig().chatgpt.apiBaseUrl;
  const cacheKey = [bundle.accountId, bundle.accessToken, baseURL].join('\u0000');

  return getOrCreateCachedClient(
    clientCache,
    cacheKey,
    () =>
      new OpenAI({
        apiKey: bundle.accessToken,
        baseURL,
        defaultHeaders: buildChatGptHeaders(bundle),
        // Passive plan-usage capture: every backend response carries x-codex-*
        // rate-limit headers, so tap them without an extra request.
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          captureChatGptUsageHeaders(bundle.accountId, response.headers);
          return response;
        },
      }),
    {
      onHit: () => recordProviderCacheHit('chatgpt', 'sdk-client'),
      onMiss: () => recordProviderCacheMiss('chatgpt', 'sdk-client'),
    }
  );
}

/** Headers the ChatGPT backend requires on every API request. */
export function buildChatGptHeaders(bundle: ChatGptTokenBundle): Record<string, string> {
  return {
    'chatgpt-account-id': bundle.accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'mangostudio',
  };
}
