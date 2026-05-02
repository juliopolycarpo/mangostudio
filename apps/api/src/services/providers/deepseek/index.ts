import OpenAI from 'openai';
import { generateText, streamText } from 'ai';
import type { SecretMetadataRow } from '@mangostudio/shared/types';

import { registerProvider } from '../core/provider-registry';
import { withModelCache } from '../core/model-cache';
import { createProviderSecretService } from '../core/secret-service';
import { createDeepSeekClient, validateDeepSeekApiKey } from './client';
import { fetchDeepSeekModels, getDeepSeekFallbackModels } from './model-catalog';
import { buildDeepSeekProviderOptions, normalizeDeepSeekBaseUrl } from './options';
import { buildDeepSeekMessages, buildDeepSeekSystemPrompt, toErrorMessage } from './normalizers';
import { streamDeepSeekAgentTurn } from './agent-stream';
import type {
  AIProvider,
  ModelInfo,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
  AgentTurnRequest,
  AgentEvent,
} from '../types';
import { parseStringArray } from '../../../utils/json';

const GENERATION_TIMEOUT_MS = 120_000;

const secretService = createProviderSecretService({
  provider: 'deepseek',
  tomlSection: 'deepseek_api_keys',
  envVarPrefix: 'DEEPSEEK_API_KEY',
  validateFn: (apiKey, fetchImpl) => validateDeepSeekApiKey({ apiKey, fetchImpl }),
});

async function resolveClientConfig(
  userId: string,
  modelName?: string
): Promise<{
  apiKey: string;
  baseUrl: string;
}> {
  await secretService.syncConfigFileConnectors(userId);
  const rows = await secretService.listMeta('deepseek', userId);

  for (const row of rows) {
    if (!row.configured) continue;
    const enabled = parseStringArray(row.enabledModels);
    if (modelName && !enabled.includes(modelName)) continue;
    const apiKey = await secretService.resolveSecretValue(row);
    if (!apiKey) continue;
    return { apiKey, baseUrl: normalizeDeepSeekBaseUrl(row.baseUrl) };
  }

  throw new DeepSeekConnectorError('No DeepSeek API key is configured for the requested model.');
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('deepseek', userId);
    const configuredRows = rows.filter((row) => row.configured);
    if (configuredRows.length === 0) return [];

    const models = new Map<string, ModelInfo>();

    for (const row of configuredRows) {
      const apiKey = await secretService.resolveSecretValue(row);
      if (!apiKey) continue;
      const connectorModels = await listConnectorModels(row, apiKey);
      connectorModels.forEach((model) => models.set(model.modelId, model));
    }

    return Array.from(models.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
  { ttl: 3_600_000, fallback: [] }
);

async function listConnectorModels(row: SecretMetadataRow, apiKey: string): Promise<ModelInfo[]> {
  try {
    return await fetchDeepSeekModels({ apiKey, baseUrl: row.baseUrl });
  } catch {
    return getDeepSeekFallbackModels();
  }
}

const deepSeekProvider: AIProvider = {
  providerType: 'deepseek',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createDeepSeekClient({ apiKey, baseUrl });
    const result = await generateText({
      model: client(req.modelName),
      system: buildDeepSeekSystemPrompt(req),
      messages: buildDeepSeekMessages(req),
      abortSignal: req.signal,
      timeout: { totalMs: GENERATION_TIMEOUT_MS },
      providerOptions: buildDeepSeekProviderOptions(req.generationConfig),
    });

    if (!result.text) {
      throw new DeepSeekConnectorError(`No text returned from DeepSeek model "${req.modelName}".`);
    }

    return { text: result.text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = createDeepSeekClient({ apiKey, baseUrl });
    const result = streamText({
      model: client(req.modelName),
      system: buildDeepSeekSystemPrompt(req),
      messages: buildDeepSeekMessages(req),
      abortSignal: req.signal,
      timeout: { totalMs: GENERATION_TIMEOUT_MS },
      providerOptions: buildDeepSeekProviderOptions(req.generationConfig),
    });

    for await (const part of result.fullStream) {
      if (req.signal?.aborted) break;
      if (part.type === 'text-delta' && part.text) {
        yield { type: 'text', text: part.text, done: false };
      }
      if (part.type === 'reasoning-delta' && part.text) {
        yield { type: 'thinking', text: part.text, done: false };
      }
      if (part.type === 'error') {
        yield {
          type: 'error',
          content: toErrorMessage(part.error, 'DeepSeek stream failed'),
          done: true,
        };
        return;
      }
    }

    yield { type: 'text', text: '', done: true };
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const { apiKey, baseUrl } = await resolveClientConfig(req.userId, req.modelName);
    const client = new OpenAI({
      apiKey,
      baseURL: normalizeDeepSeekBaseUrl(baseUrl),
    });
    yield* streamDeepSeekAgentTurn(client, req);
  },

  async listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache(userId?: string): void {
    listModelsWithCache.invalidate(userId);
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await secretService.syncConfigFileConnectors(userId);
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await secretService.validateApiKey(apiKey);
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveClientConfig(userId, modelName);
    return apiKey;
  },
};

export class DeepSeekConnectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeepSeekConnectorError';
  }
}

registerProvider(deepSeekProvider);

export { deepSeekProvider };
