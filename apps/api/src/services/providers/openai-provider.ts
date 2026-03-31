/**
 * AIProvider adapter for the official OpenAI API.
 * Always uses https://api.openai.com/v1. For custom endpoints use openai-compatible.
 *
 * Validation and runtime both use the same OpenAI auth context (apiKey +
 * optional organizationId / projectId) so that project-scoped keys are never
 * rejected during connector setup.
 */

import OpenAI from 'openai';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createProviderSecretService } from './secret-service';
import { withModelCache } from './model-cache';
import { registerProvider } from './registry';
import { getConfig } from '../../lib/config';
import type {
  AIProvider,
  TextGenerationRequest,
  TextGenerationResult,
  StreamingTextChunk,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelInfo,
} from './types';
import type { SecretMetadataRow } from '@mangostudio/shared/types';

const BASE_URL = 'https://api.openai.com/v1';

// ---------------------------------------------------------------------------
// Shared OpenAI auth-context shape
// ---------------------------------------------------------------------------

/** All credentials needed to authenticate with the OpenAI API. */
export interface OpenAIAuthContext {
  apiKey: string;
  organizationId?: string | null;
  projectId?: string | null;
}

// ---------------------------------------------------------------------------
// Error classes for actionable connector failures
// ---------------------------------------------------------------------------

/** Thrown when OpenAI rejects the key or auth context (HTTP 401 / 403). */
export class OpenAIAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenAIAuthError';
    this.status = status;
  }
}

/** Thrown when the connector configuration is incomplete or malformed. */
export class OpenAIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIConfigError';
  }
}

// ---------------------------------------------------------------------------
// SDK client factory
// ---------------------------------------------------------------------------

/**
 * Creates an OpenAI SDK client from a full auth context.
 * Passes organization and project so that project-scoped keys work correctly.
 */
function createClient(ctx: OpenAIAuthContext): OpenAI {
  return new OpenAI({
    apiKey: ctx.apiKey,
    baseURL: BASE_URL,
    ...(ctx.organizationId ? { organization: ctx.organizationId } : {}),
    ...(ctx.projectId ? { project: ctx.projectId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Auth-context validation — shared by both the route-level validateProviderKey
// and the provider's own validateApiKey method.
// ---------------------------------------------------------------------------

/**
 * Validates an OpenAI auth context by listing models through the SDK.
 * Uses the exact same client construction as runtime so that project/org
 * scoping cannot diverge between validation and generation.
 *
 * @throws {OpenAIAuthError} for 401 / 403 responses.
 * @throws {OpenAIConfigError} for other API errors that indicate bad config.
 */
export async function validateOpenAIAuthContext(ctx: OpenAIAuthContext): Promise<void> {
  const client = createClient(ctx);
  try {
    // Requesting only 1 model to minimize bandwidth; we only care that the
    // credentials are accepted.
    await client.models.list();
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      if (err.status === 401) {
        throw new OpenAIAuthError(
          'OpenAI API key is invalid or expired. Verify your key and try again.',
          401
        );
      }
      if (err.status === 403) {
        throw new OpenAIAuthError(
          'OpenAI access denied. Check that your organization ID, project ID, and key permissions are correct.',
          403
        );
      }
      throw new OpenAIConfigError(
        `OpenAI connector validation failed (HTTP ${err.status}): ${err.message}`
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Secret service — used for storage / key resolution
// ---------------------------------------------------------------------------

const secretService = createProviderSecretService({
  provider: 'openai',
  tomlSection: 'openai_api_keys',
  envVarPrefix: 'OPENAI_API_KEY',
  /**
   * The validateFn here is only invoked by the secret-service layer when no
   * full row context is available (e.g. config-file keys). The route-level
   * validateProviderKey is the primary path for connector creation, which has
   * full auth context.
   */
  validateFn: async (apiKey) => {
    await validateOpenAIAuthContext({ apiKey });
  },
});

// ---------------------------------------------------------------------------
// Auth-context resolution for runtime calls
// ---------------------------------------------------------------------------

/**
 * Resolves the full OpenAI auth context (key + optional org/project) from the
 * first configured connector that matches the optional model filter.
 */
async function resolveAuthContext(userId: string, modelName?: string): Promise<OpenAIAuthContext> {
  await secretService.syncConfigFileConnectors(userId);
  const rows = await secretService.listMeta('openai', userId);

  for (const row of rows) {
    if (!row.configured) continue;
    const enabled: string[] = JSON.parse(row.enabledModels);
    if (modelName && enabled.length > 0 && !enabled.includes(modelName)) continue;

    const apiKey = await secretService.resolveSecretValue(row);
    if (apiKey) {
      return {
        apiKey,
        organizationId: (row as SecretMetadataRow).organizationId ?? null,
        projectId: (row as SecretMetadataRow).projectId ?? null,
      };
    }
  }

  throw new Error('No OpenAI API key is configured or enabled. Check your Connectors in Settings.');
}

// ---------------------------------------------------------------------------
// Model listing (cached)
// ---------------------------------------------------------------------------

const listModelsWithCache = withModelCache(
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
          organizationId: (row as SecretMetadataRow).organizationId ?? null,
          projectId: (row as SecretMetadataRow).projectId ?? null,
        };
        break;
      }
    }

    if (!resolvedCtx) return [];

    const allModels: ModelInfo[] = [];
    try {
      const client = createClient(resolvedCtx);
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
          capabilities: {
            text: !model.id.startsWith('dall-e'),
            image: model.id.startsWith('dall-e'),
            streaming: !model.id.startsWith('dall-e'),
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

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

function buildMessages(req: TextGenerationRequest): OpenAI.ChatCompletionMessageParam[] {
  return [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...req.history.map(
      (msg): OpenAI.ChatCompletionMessageParam => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.text,
      })
    ),
    { role: 'user' as const, content: req.prompt },
  ];
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const openAIProvider: AIProvider = {
  providerType: 'openai',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);

    const completion = await client.chat.completions.create(
      { model: req.modelName, messages: buildMessages(req), stream: false },
      { signal: req.signal }
    );

    const text = completion.choices[0]?.message?.content ?? '';
    if (!text) throw new Error('No text returned from OpenAI API.');
    return { text };
  },

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingTextChunk> {
    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);

    const stream = await client.chat.completions.create(
      { model: req.modelName, messages: buildMessages(req), stream: true },
      { signal: req.signal }
    );

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield { text: delta, done: false };
    }
    yield { text: '', done: true };
  },

  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!req.modelName.startsWith('dall-e')) {
      throw new Error('Image generation is only supported by DALL-E models.');
    }

    const ctx = await resolveAuthContext(req.userId, req.modelName);
    const client = createClient(ctx);

    const response = await client.images.generate({
      model: req.modelName,
      prompt: req.prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    });

    const remoteUrl = response.data?.[0]?.url;
    if (!remoteUrl) throw new Error('No image returned from OpenAI DALL-E.');

    const uploadsDir = getConfig().uploads.dir;
    mkdirSync(uploadsDir, { recursive: true });

    const imageResponse = await fetch(remoteUrl);
    if (!imageResponse.ok) {
      throw new Error('Failed to download generated image from OpenAI CDN.');
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const filename = `generated-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
    await Bun.write(join(uploadsDir, filename), imageBuffer);

    return { imageUrl: `/uploads/${filename}` };
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

  /**
   * Validates an API key using SDK-backed model listing.
   * Delegates to validateOpenAIAuthContext so that validation and runtime
   * share the same code path.
   */
  async validateApiKey(apiKey: string): Promise<void> {
    await validateOpenAIAuthContext({ apiKey });
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveAuthContext(userId, modelName);
    return apiKey;
  },
};

// Self-register on import
registerProvider(openAIProvider);

export { openAIProvider };
