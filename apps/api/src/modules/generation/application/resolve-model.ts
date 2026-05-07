import {
  getCachedModelCapabilities,
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

  if (!modelId) {
    const catalog = await getUnifiedModelCatalog(input.userId);
    const availableModels = input.type === 'text' ? catalog.textModels : catalog.imageModels;
    if (availableModels.length === 0) {
      throw new NoModelAvailableError(input.type);
    }

    const selectedModel = availableModels[0];
    modelId = selectedModel.modelId;
    capabilities = selectedModel.capabilities;
  } else {
    capabilities = getCachedModelCapabilities(input.userId, modelId);
  }

  if (!modelId) {
    throw new NoModelAvailableError(input.type);
  }

  return capabilities ? { modelId, capabilities } : { modelId };
}
