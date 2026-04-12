/**
 * Provider-specific API key validation.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { getProvider } from '../../../services/providers/registry';
import {
  validateOpenAIAuthContext,
  OpenAIAuthError,
  OpenAIConfigError,
} from '../../../services/providers/openai-provider';
import { validateBaseUrl, UnsafeBaseUrlError } from '../../../services/providers/base-url-policy';

export { OpenAIAuthError, OpenAIConfigError, UnsafeBaseUrlError };

/** Validates an API key for the given provider. */
export async function validateProviderKey(
  provider: ProviderType,
  apiKey: string,
  options?: { baseUrl?: string; organizationId?: string; projectId?: string }
): Promise<void> {
  if (provider === 'openai') {
    await validateOpenAIAuthContext({
      apiKey,
      organizationId: options?.organizationId,
      projectId: options?.projectId,
    });
    return;
  }

  if (provider === 'openai-compatible' && options?.baseUrl) {
    await validateBaseUrl(options.baseUrl);
    const response = await fetch(`${options.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(
        `API key validation failed for ${options.baseUrl} (HTTP ${response.status}).`
      );
    }
    return;
  }

  if (provider === 'openai-compatible' && !options?.baseUrl) {
    throw new Error('baseUrl is required for openai-compatible connectors.');
  }

  const p = getProvider(provider);
  await p.validateApiKey(apiKey);
}
