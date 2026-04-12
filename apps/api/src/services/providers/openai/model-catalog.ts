/**
 * OpenAI model listing with TTL cache.
 */

import { withModelCache } from '../core/model-cache';
import { getModelContextLimit } from '../core/context-policy';
import { isImageModelId, isReasoningModel } from '../core/capability-detector';
import { createProviderSecretService } from '../core/secret-service';
import { parseStringArray } from '../../../utils/json';
import { createOpenAIClient, validateOpenAIAuthContext, type OpenAIAuthContext } from './client';
import type { ModelInfo } from '../types';

export const secretService = createProviderSecretService({
  provider: 'openai',
  tomlSection: 'openai_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  validateFn: async (apiKey) => {
    await validateOpenAIAuthContext({ apiKey });
  },
});

/**
 * Resolves the full OpenAI auth context (key + optional org/project) from the
 * first configured connector that matches the optional model filter.
 */
export async function resolveAuthContext(
  userId: string,
  modelName?: string
): Promise<OpenAIAuthContext> {
  const rows = await secretService.listMeta('openai', userId);

  for (const row of rows) {
    if (!row.configured) continue;
    const enabled = parseStringArray(row.enabledModels);
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;

    const apiKey = await secretService.resolveSecretValue(row);
    if (apiKey) {
      return {
        apiKey,
        organizationId: row.organizationId ?? null,
        projectId: row.projectId ?? null,
      };
    }
  }

  throw new Error('No OpenAI API key is configured or enabled. Check your Connectors in Settings.');
}

export const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('openai', userId);

    let resolvedCtx: OpenAIAuthContext | null = null;
    for (const row of rows) {
      if (!row.configured) continue;
      const apiKey = await secretService.resolveSecretValue(row);
      if (apiKey) {
        resolvedCtx = {
          apiKey,
          organizationId: row.organizationId ?? null,
          projectId: row.projectId ?? null,
        };
        break;
      }
    }

    if (!resolvedCtx) return [];

    const allModels: ModelInfo[] = [];
    try {
      const client = createOpenAIClient(resolvedCtx);
      for await (const model of await client.models.list()) {
        if (
          model.id.includes('embedding') ||
          model.id.includes('tts') ||
          model.id.includes('whisper') ||
          model.id.includes('moderation')
        ) {
          continue;
        }
        allModels.push({
          modelId: model.id,
          displayName: model.id,
          provider: 'openai',
          inputTokenLimit: getModelContextLimit(model.id),
          capabilities: {
            text: !isImageModelId(model.id),
            image: isImageModelId(model.id),
            streaming: !isImageModelId(model.id),
            reasoning: isReasoningModel(model.id),
            tools: !isImageModelId(model.id),
            statefulContinuation: !isImageModelId(model.id),
            promptCaching: true,
            parallelToolCalls: !isImageModelId(model.id),
            reasoningWithTools: isReasoningModel(model.id),
          },
        });
      }
    } catch (err) {
      console.warn(`[openai] Failed to list models:`, err);
    }

    return allModels.sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
  { ttl: 3_600_000, fallback: [] }
);
