/**
 * Provider-specific API key validation.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import {
  UnsafeBaseUrlError,
  validateBaseUrl,
} from '../../../services/providers/core/base-url-policy';
import { healthcheckProviderConnection } from '../../../services/providers/core/provider-readiness';
import { OpenAIAuthError, OpenAIConfigError } from '../../../services/providers/openai/index';

export { OpenAIAuthError, OpenAIConfigError, UnsafeBaseUrlError };

/** Validates an API key for the given provider. */
export async function validateProviderKey(
  provider: ProviderType,
  apiKey: string,
  options?: { baseUrl?: string; organizationId?: string; projectId?: string }
): Promise<void> {
  if (provider === 'openai-compatible' && !options?.baseUrl) {
    throw new Error('baseUrl is required for openai-compatible connectors.');
  }

  if (provider === 'deepseek' && options?.baseUrl) {
    await validateBaseUrl(options.baseUrl);
  }

  await healthcheckProviderConnection(provider, {
    apiKey,
    baseUrl: options?.baseUrl,
    organizationId: options?.organizationId,
    projectId: options?.projectId,
  });
}
