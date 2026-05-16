import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { generateText, streamText } from 'ai';
import { parseStringArray } from '../../../utils/json';
import { withModelCache } from '../core/model-cache';
import { recordProviderCacheHit, recordProviderCacheMiss } from '../core/provider-observability';
import { registerProvider } from '../core/provider-registry';
import { createReadinessCache, createReadinessCacheKey } from '../core/readiness-cache';
import { createProviderSecretService } from '../core/secret-service';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ModelInfo,
  ProviderHealthcheckRequest,
  ProviderWarmupRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { streamDeepSeekAgentTurn } from './agent-stream';
import { createDeepSeekAgentClient, createDeepSeekClient, validateDeepSeekApiKey } from './client';
import { fetchDeepSeekModels, getDeepSeekFallbackModels } from './model-catalog';
import { buildDeepSeekMessages, buildDeepSeekSystemPrompt, toErrorMessage } from './normalizers';
import { buildDeepSeekProviderOptions, normalizeDeepSeekBaseUrl } from './options';

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
      for (const model of connectorModels) models.set(model.modelId, model);
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

interface PreparedDeepSeekRuntime {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly textClient: ReturnType<typeof createDeepSeekClient>;
  readonly agentClient: ReturnType<typeof createDeepSeekAgentClient>;
}

const preparedRuntimeCache = createReadinessCache<PreparedDeepSeekRuntime>({
  onHit: () => recordProviderCacheHit('deepseek', 'prepared-runtime'),
  onMiss: () => recordProviderCacheMiss('deepseek', 'prepared-runtime'),
});

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedDeepSeekRuntime> {
  const { apiKey, baseUrl } = await resolveClientConfig(userId, modelName);
  return {
    apiKey,
    baseUrl,
    textClient: createDeepSeekClient({ apiKey, baseUrl }),
    agentClient: createDeepSeekAgentClient({ apiKey, baseUrl }),
  };
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
async function prepareRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedDeepSeekRuntime> {
  return preparedRuntimeCache.get(createReadinessCacheKey(userId, modelName), () =>
    loadPreparedRuntime(userId, modelName)
  );
}

function invalidatePreparedRuntime(userId?: string): void {
  if (!userId) {
    preparedRuntimeCache.clearWhere(() => true);
    return;
  }

  preparedRuntimeCache.clearByUserPrefix(userId);
}

const deepSeekProvider: AIProvider = {
  providerType: 'deepseek',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { textClient } = await prepareRuntime(req.userId, req.modelName);
    const result = await generateText({
      model: textClient(req.modelName),
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
    const { textClient } = await prepareRuntime(req.userId, req.modelName);
    const result = streamText({
      model: textClient(req.modelName),
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
    const { agentClient } = await prepareRuntime(req.userId, req.modelName);
    yield* streamDeepSeekAgentTurn(agentClient, req);
  },

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  async listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache(userId?: string): void {
    listModelsWithCache.invalidate(userId);
    invalidatePreparedRuntime(userId);
  },

  async syncConfigFileConnectors(userId: string): Promise<void> {
    await secretService.syncConfigFileConnectors(userId);
  },

  async warmup(req: ProviderWarmupRequest): Promise<void> {
    await preparedRuntimeCache.prime(createReadinessCacheKey(req.userId, req.modelName), () =>
      loadPreparedRuntime(req.userId, req.modelName)
    );
  },

  async healthcheck(req: ProviderHealthcheckRequest): Promise<void> {
    if (!req.apiKey?.trim()) {
      throw new Error('deepseek healthcheck requires an API key.');
    }

    await validateDeepSeekApiKey({
      apiKey: req.apiKey.trim(),
      baseUrl: req.baseUrl,
    });
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
