import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { parseStringArray } from '../../../utils/json';
import { withModelCache } from '../core/model-cache';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import { createProviderSecretService } from '../core/secret-service';
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
import { streamDeepSeekAgentTurn } from './agent-stream';
import { createDeepSeekClient, validateDeepSeekApiKey } from './client';
import { fetchDeepSeekModels, getDeepSeekFallbackModels } from './model-catalog';
import { normalizeDeepSeekBaseUrl } from './options';
import { generateDeepSeekText, streamDeepSeekText } from './text-stream';

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
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;
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
  readonly client: ReturnType<typeof createDeepSeekClient>;
}

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedDeepSeekRuntime> {
  const { apiKey, baseUrl } = await resolveClientConfig(userId, modelName);
  return {
    apiKey,
    baseUrl,
    client: createDeepSeekClient({ apiKey, baseUrl }),
  };
}

const lifecycle = createProviderLifecycle<PreparedDeepSeekRuntime>({
  provider: 'deepseek',
  loadPreparedRuntime,
  invalidateCachedModels: listModelsWithCache.invalidate,
  syncConfigFileConnectors: secretService.syncConfigFileConnectors,
});

const deepSeekProvider: AIProvider = {
  providerType: 'deepseek',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    const result = await generateDeepSeekText(client, req);

    if (!result.text) {
      throw new DeepSeekConnectorError(`No text returned from DeepSeek model "${req.modelName}".`);
    }

    return result;
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamDeepSeekText(client, req);
  },

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const { client } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    yield* streamDeepSeekAgentTurn(client, req);
  },

  listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache: lifecycle.invalidateModelCache,
  syncConfigFileConnectors: lifecycle.syncConfigFileConnectors,
  warmup: lifecycle.warmup,

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

class DeepSeekConnectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeepSeekConnectorError';
  }
}

export { deepSeekProvider };
