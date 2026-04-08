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

export function getModelSelectorPlaceholder(catalog: ModelCatalogResponse): string {
  if (catalog.status === 'loading') {
    return 'Loading models...';
  }

  if (catalog.status === 'error') {
    return 'Models unavailable';
  }

  return 'No models available';
}
