import type { ModelUnavailableDetails } from '@mangostudio/shared/generation';
import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import type { ProviderType } from '@mangostudio/shared/types';
import {
  getCachedModelMetadata,
  getUnifiedModelCatalog,
} from '../../../services/providers/catalog';
import { recordDeprecatedProviderAttempt } from '../../../services/providers/core/provider-observability';
import { resolveProviderTypeForModel } from '../../../services/providers/core/provider-registry';
import type { ModelCapabilities } from '../../../services/providers/types';

export interface ResolveModelInput {
  requestedModel?: string;
  userId: string;
  type: 'text' | 'image';
}

export interface ResolvedModel {
  modelId: string;
  capabilities?: ModelCapabilities;
  providerType?: ProviderType;
}

/**
 * No model to run this turn on, and why.
 *
 * One error class for both reasons because every caller already catches this
 * one, so a deprecated provider is refused at the streaming turn, the
 * non-streaming respond route, title generation, commit messages, compaction,
 * subagents and library agent strategies without any of them growing a second
 * catch. What differs is `details`, which is what the client renders.
 */
export class NoModelAvailableError extends Error {
  readonly details: ModelUnavailableDetails;

  constructor(type: 'text' | 'image', details?: ModelUnavailableDetails) {
    super(
      details?.reason === 'provider-deprecated'
        ? `MangoStudio no longer runs ${details.provider ?? 'this provider'} models. Continue in a new chat with the ${details.targetId ?? 'vendor'} CLI, or pick another model.`
        : type === 'text'
          ? 'No text model available. Configure a connector in Settings.'
          : 'No image model available. Configure a connector in Settings.'
    );
    this.name = 'NoModelAvailableError';
    this.details = details ?? { reason: 'not-configured', action: 'configure-connector' };
  }
}

/**
 * Refuses a turn whose model belongs to a provider MangoStudio no longer owns.
 *
 * This sits in `resolveModel` rather than in the routes because hiding a
 * provider's catalog entries does not stop it running: an explicit stored id is
 * accepted even when catalog metadata is absent, so a chat already carrying
 * `cursor/composer-2.5` would keep reaching the deprecated provider forever.
 * One guard before provider resolution is the only placement that every path
 * to a provider passes through.
 *
 * The catalog no longer lists deprecated providers, so the model's provider is
 * recovered from the connector rows that still have it enabled. A model no
 * connector claims is not this guard's problem — it falls through to whatever
 * the caller already does with an unroutable id.
 */
async function assertProviderNotDeprecated(
  userId: string,
  modelId: string,
  known: ProviderType | undefined
): Promise<void> {
  const providerType = known ?? (await resolveProviderTypeForModel(modelId, userId));
  if (!providerType || !isDeprecatedProvider(providerType)) return;

  // The evidence the removal cycle needs: whether anything is still trying.
  recordDeprecatedProviderAttempt({ provider: providerType, modelId });

  throw new NoModelAvailableError('text', {
    reason: 'provider-deprecated',
    // Deliberately not "pick another model": that one is always available in
    // the composer, and naming it as the action would bury the migration path.
    action: 'fork-with-external-runner',
    modelId,
    provider: providerType,
    ...(providerType === 'cursor' ? { targetId: 'cursor' as const } : {}),
  });
}

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {
  let modelId = input.requestedModel?.trim() || '';
  let capabilities: ModelCapabilities | undefined;
  let providerType: ProviderType | undefined;

  if (!modelId) {
    const catalog = await getUnifiedModelCatalog(input.userId);
    const availableModels = input.type === 'text' ? catalog.textModels : catalog.imageModels;
    if (availableModels.length === 0) {
      throw new NoModelAvailableError(input.type);
    }

    const selectedModel = availableModels[0];
    modelId = selectedModel.modelId;
    capabilities = selectedModel.capabilities;
    providerType = selectedModel.provider;
  } else {
    const cachedModel = getCachedModelMetadata(input.userId, modelId);
    capabilities = cachedModel?.capabilities;
    providerType = cachedModel?.providerType;
  }

  if (!modelId) {
    throw new NoModelAvailableError(input.type);
  }

  await assertProviderNotDeprecated(input.userId, modelId, providerType);

  return {
    modelId,
    ...(capabilities ? { capabilities } : {}),
    ...(providerType ? { providerType } : {}),
  };
}
