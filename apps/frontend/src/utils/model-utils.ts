import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared';

export const EMPTY_MODEL_CATALOG: ModelCatalogResponse = {
  configured: false,
  status: 'idle',
  allModels: [],
  textModels: [],
  imageModels: [],
  discoveredTextModels: [],
  discoveredImageModels: [],
};

export function hasModelOption(modelId: string | undefined, options: ModelOption[]): boolean {
  return Boolean(modelId) && options.some((option) => option.modelId === modelId);
}

export function resolveSelectedModel(
  selectedModel: string | undefined,
  options: ModelOption[]
): string {
  if (selectedModel && hasModelOption(selectedModel, options)) {
    return selectedModel;
  }

  return options[0]?.modelId ?? '';
}

export function resolveActiveModeModel(
  chatModel: string | undefined,
  globalModel: string | undefined,
  options: ModelOption[]
): string {
  if (chatModel && hasModelOption(chatModel, options)) {
    return chatModel;
  }

  return resolveSelectedModel(globalModel, options);
}

export interface ModelSelectorLabels {
  loading: string;
  unavailable: string;
  noModelsAvailable: string;
}

export function getModelSelectorPlaceholder(
  catalog: ModelCatalogResponse,
  labels: ModelSelectorLabels
): string {
  if (catalog.status === 'loading') {
    return labels.loading;
  }

  if (catalog.status === 'error') {
    return labels.unavailable;
  }

  return labels.noModelsAvailable;
}
