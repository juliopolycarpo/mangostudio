/**
 * AIProvider adapter for ChatGPT subscription accounts.
 *
 * Connectors are created through the OAuth session flow, not POST /connectors,
 * and the secret is a rotating token bundle owned by the chatgpt token
 * service. The backend speaks the Responses protocol with `store: false` and
 * no server-side cursor, so agentic turns run as stateless replay: full
 * history plus turn-local items are re-sent on every iteration.
 */

import type { SecretMetadataRow } from '@mangostudio/shared/types';
import type OpenAI from 'openai';
import { APIError as OpenAIAPIError } from 'openai';
import { getConfig } from '../../../lib/config';
import {
  ChatGptReauthRequiredError,
  type ChatGptTokenBundle,
  parseChatGptTokenBundle,
  refreshTokenGrant,
} from '../../../modules/connectors/infrastructure/chatgpt/oauth-client';
import {
  getChatGptTokenService,
  markChatGptConnectorReauthRequired,
} from '../../../modules/connectors/infrastructure/chatgpt/token-service';
import { listSecretMetadata } from '../../secret-store/metadata';
import { selectConnectorRowsForModel } from '../core/connector-model-rows';
import { withModelCache } from '../core/model-cache';
import type { ResponsesRequestPolicy } from '../core/responses-protocol/request-builder';
import { streamAgentTurnWithResponses, streamResponses } from '../core/responses-protocol/stream';
import { ProviderApiKeyMissingError } from '../core/secret-service';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ModelInfo,
  ProviderHealthcheckRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { CHATGPT_BASE_INSTRUCTIONS } from './base-instructions';
import { createChatGptClient } from './client';
import { ChatGptBackendAuthError, fetchChatGptModelIds, listChatGptModels } from './model-catalog';

export { ChatGptReauthRequiredError };

export const CHATGPT_RESPONSES_POLICY: ResponsesRequestPolicy = {
  provider: 'chatgpt',
  store: false,
  continuation: 'stateless-replay',
  instructions: { pinned: CHATGPT_BASE_INSTRUCTIONS },
  // The backend accepts developer-role input items; the MangoStudio system
  // prompt travels there because `instructions` is reserved for the pinned
  // base prompt. Test-locked in the request-policy unit tests.
  systemPromptRole: 'developer',
  include: ['reasoning.encrypted_content'],
  allowMaxOutputTokens: false,
  // Mango exposes xhigh in settings; the backend tops out at high.
  reasoningEffortCeiling: 'high',
  reasoningSummary: 'auto',
  extraHeaders: (ctx): Record<string, string> =>
    ctx.sessionId ? { session_id: ctx.sessionId } : {},
};

interface ChatGptRuntime {
  bundle: ChatGptTokenBundle;
  connector: SecretMetadataRow;
}

/** Resolves the first configured connector that may serve the model. */
async function resolveRuntime(userId: string, modelName?: string): Promise<ChatGptRuntime> {
  const rows = await listSecretMetadata('chatgpt', userId);
  for (const connector of selectConnectorRowsForModel(rows, modelName)) {
    const bundle = await getChatGptTokenService().ensureFreshTokens(connector);
    return { bundle, connector };
  }
  throw new ProviderApiKeyMissingError('chatgpt');
}

function isAuthRejection(err: unknown): boolean {
  if (err instanceof ChatGptBackendAuthError) return true;
  return err instanceof OpenAIAPIError && err.status === 401;
}

/**
 * Streams through the backend with the 401 policy: when the backend rejects
 * the access token before any output was produced, force-refresh the bundle
 * once and retry once; a second rejection surfaces as reauth-required. A 401
 * after partial output is not retried (the turn is already broken).
 */
async function* streamWithAuthRetry<T>(
  userId: string,
  modelName: string,
  makeStream: (client: OpenAI) => AsyncIterable<T>
): AsyncGenerator<T> {
  const runtime = await resolveRuntime(userId, modelName);
  let yielded = false;
  try {
    for await (const item of makeStream(createChatGptClient(runtime.bundle))) {
      yielded = true;
      yield item;
    }
    return;
  } catch (err) {
    if (!isAuthRejection(err)) throw err;
    if (yielded) {
      await markChatGptConnectorReauthRequired(runtime.connector);
      throw new ChatGptReauthRequiredError();
    }
  }

  const refreshed = await getChatGptTokenService().forceRefreshTokens(runtime.connector);
  try {
    yield* makeStream(createChatGptClient(refreshed));
  } catch (err) {
    if (isAuthRejection(err)) {
      await markChatGptConnectorReauthRequired(runtime.connector);
      throw new ChatGptReauthRequiredError();
    }
    throw err;
  }
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    const rows = await listSecretMetadata('chatgpt', userId);
    const models = new Map<string, ModelInfo>();

    for (const connector of rows.filter((row) => row.configured)) {
      try {
        const bundle = await getChatGptTokenService().ensureFreshTokens(connector);
        for (const model of await listChatGptModels(bundle)) {
          models.set(model.modelId, model);
        }
      } catch {
        // A broken connector must not take down listing for the healthy ones.
      }
    }

    return Array.from(models.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
  { ttl: 3_600_000, fallback: [] }
);

/**
 * Probes the backend with a bundle's access token. Auth rejections propagate;
 * other failures are tolerated because the discovery endpoint is best-effort.
 */
async function probeBackend(bundle: ChatGptTokenBundle): Promise<void> {
  try {
    await fetchChatGptModelIds(bundle);
  } catch (err) {
    if (err instanceof ChatGptBackendAuthError) throw err;
  }
}

const chatGptProvider: AIProvider = {
  providerType: 'chatgpt',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    let text = '';
    for await (const chunk of this.generateTextStream?.(req) ?? []) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    if (!text.trim()) {
      throw new Error(`No text returned from ChatGPT model "${req.modelName}".`);
    }
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    // Every chatgpt model goes through the Responses protocol — the backend
    // has no chat-completions endpoint — so there is no reasoning-model split.
    yield* streamWithAuthRetry(req.userId, req.modelName, (client) =>
      streamResponses(client, req, CHATGPT_RESPONSES_POLICY)
    );
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    yield* streamWithAuthRetry(req.userId, req.modelName, (client) =>
      streamAgentTurnWithResponses(client, req, CHATGPT_RESPONSES_POLICY)
    );
  },

  listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache: listModelsWithCache.invalidate,

  async healthcheck(req: ProviderHealthcheckRequest): Promise<void> {
    if (!req.apiKey?.trim()) {
      throw new Error('chatgpt healthcheck requires a stored token bundle.');
    }
    await this.validateApiKey(req.apiKey);
  },

  /**
   * Validates a raw token bundle. Probes the backend with the current access
   * token when it is still valid; refreshing here would rotate the stored
   * refresh token without persisting it, so the refresh probe runs only for
   * expired bundles (creation-time validation, where nothing is stored yet).
   */
  async validateApiKey(apiKey: string): Promise<void> {
    const bundle = parseChatGptTokenBundle(apiKey);
    if (bundle.expiresAt > Date.now()) {
      await probeBackend(bundle);
      return;
    }
    const refreshed = await refreshTokenGrant({
      bundle,
      authBaseUrl: getConfig().chatgpt.authBaseUrl,
    });
    await probeBackend(refreshed);
  },

  /** Resolves a fresh access token for the connector serving the model. */
  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { bundle } = await resolveRuntime(userId, modelName);
    return bundle.accessToken;
  },
};

export { chatGptProvider };
