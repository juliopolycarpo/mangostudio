/**
 * OpenAI model listing with TTL cache.
 */

import { parseStringArray } from '../../../utils/json';
import { isImageModelId, isReasoningModel } from '../core/capability-detector';
import { getModelContextLimit } from '../core/context-policy';
import { withModelCache } from '../core/model-cache';
import { PROVIDER_PROBE_TIMEOUT_MS, withAbortTimeout } from '../core/probe-timeout';
import { recordProviderProbeTimeout } from '../core/provider-observability';
import { createProviderSecretService } from '../core/secret-service';
import type { ModelInfo } from '../types';
import { createOpenAIClient, type OpenAIAuthContext, validateOpenAIAuthContext } from './client';

const KNOWN_OPENAI_IMAGE_MODEL_IDS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'chatgpt-image-latest',
  'gpt-image-1',
  'gpt-image-1-mini',
  'dall-e-3',
  'dall-e-2',
] as const;

function createImageModelInfo(modelId: string): ModelInfo {
  return {
    modelId,
    displayName: modelId,
    provider: 'openai',
    capabilities: {
      text: false,
      image: true,
      streaming: false,
      reasoning: false,
      tools: false,
      statefulContinuation: false,
      promptCaching: false,
      parallelToolCalls: false,
      reasoningWithTools: false,
      structuredOutput: false,
      fileAttachments: false,
      imageInput: false,
      pdfInput: false,
      textFileInput: false,
    },
  };
}

export function includeKnownOpenAIImageModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set(models.map((model) => model.modelId));
  const imageModels = KNOWN_OPENAI_IMAGE_MODEL_IDS.filter((modelId) => !seen.has(modelId)).map(
    createImageModelInfo
  );

  return [...models, ...imageModels];
}

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
      const client = createOpenAIClient(resolvedCtx, {
        timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
        maxRetries: 0,
      });
      const modelsPage = await withAbortTimeout(
        (signal) => client.models.list({ signal }),
        'OpenAI model listing timed out.',
        PROVIDER_PROBE_TIMEOUT_MS,
        () =>
          recordProviderProbeTimeout({
            provider: 'openai',
            operation: 'model-list',
            message: 'OpenAI model listing timed out.',
          })
      );
      for await (const model of modelsPage) {
        if (
          model.id.includes('embedding') ||
          model.id.includes('tts') ||
          model.id.includes('whisper') ||
          model.id.includes('moderation')
        ) {
          continue;
        }
        const isImage = isImageModelId(model.id);
        const isReasoning = isReasoningModel(model.id);
        allModels.push({
          modelId: model.id,
          displayName: model.id,
          provider: 'openai',
          inputTokenLimit: getModelContextLimit(model.id),
          capabilities: {
            text: !isImage,
            image: isImage,
            streaming: !isImage,
            reasoning: isReasoning,
            tools: !isImage,
            statefulContinuation: !isImage,
            promptCaching: true,
            parallelToolCalls: !isImage,
            reasoningWithTools: isReasoning && !isImage,
            structuredOutput: !isImage,
            fileAttachments: !isImage,
            imageInput: !isImage,
            pdfInput: !isImage,
            textFileInput: !isImage,
          },
        });
      }
    } catch (err) {
      console.warn(`[openai] Failed to list models:`, err);
    }

    return includeKnownOpenAIImageModels(allModels).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );
  },
  { ttl: 3_600_000, fallback: [] }
);
