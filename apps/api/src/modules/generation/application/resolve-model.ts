import type { ProviderType } from '@mangostudio/shared/types';
import {
  getCachedModelMetadata,
  getUnifiedModelCatalog,
} from '../../../services/providers/catalog';
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

export class NoModelAvailableError extends Error {
  constructor(type: 'text' | 'image') {
    super(
      type === 'text'
        ? 'No text model available. Configure a connector in Settings.'
        : 'No image model available. Configure a connector in Settings.'
    );
    this.name = 'NoModelAvailableError';
  }
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

  return {
    modelId,
    ...(capabilities ? { capabilities } : {}),
    ...(providerType ? { providerType } : {}),
  };
}
