/**
 * ChatGPT (subscription) provider stub.
 *
 * Connectors are created through the OAuth session flow, not POST /connectors,
 * and the secret is a rotating token bundle owned by the chatgpt token
 * service. Model listing and generation land with the ChatGPT backend
 * integration; until then this stub keeps the provider registry, catalog, and
 * settings endpoints total over the `chatgpt` provider type.
 */

import { getConfig } from '../../../lib/config';
import {
  parseChatGptTokenBundle,
  refreshTokenGrant,
} from '../../../modules/connectors/infrastructure/chatgpt/oauth-client';
import { getChatGptTokenService } from '../../../modules/connectors/infrastructure/chatgpt/token-service';
import { listSecretMetadata } from '../../secret-store/metadata';
import { ProviderApiKeyMissingError } from '../core/secret-service';
import type { AIProvider, ModelInfo, TextGenerationResult } from '../types';

export class ChatGptGenerationUnsupportedError extends Error {
  constructor() {
    super('ChatGPT text generation is not supported yet.');
    this.name = 'ChatGptGenerationUnsupportedError';
  }
}

const chatGptProvider: AIProvider = {
  providerType: 'chatgpt',

  generateText(): Promise<TextGenerationResult> {
    return Promise.reject(new ChatGptGenerationUnsupportedError());
  },

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  },

  /** Validates a raw token bundle by parsing it and probing one refresh. */
  async validateApiKey(apiKey: string): Promise<void> {
    const bundle = parseChatGptTokenBundle(apiKey);
    await refreshTokenGrant({ bundle, authBaseUrl: getConfig().chatgpt.authBaseUrl });
  },

  /** Resolves a fresh access token for the user's first configured connector. */
  async resolveApiKey(userId: string): Promise<string> {
    const rows = await listSecretMetadata('chatgpt', userId);
    for (const row of rows) {
      if (!row.configured) continue;
      const bundle = await getChatGptTokenService().ensureFreshTokens(row);
      return bundle.accessToken;
    }
    throw new ProviderApiKeyMissingError('chatgpt');
  },
};

export { chatGptProvider };
