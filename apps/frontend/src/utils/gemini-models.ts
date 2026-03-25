import type { GeminiModelCatalogResponse, GeminiModelOption } from '@mangostudio/shared';

export const EMPTY_GEMINI_MODEL_CATALOG: GeminiModelCatalogResponse = {
  configured: false,
  status: 'idle',
  allModels: [],
  textModels: [],
  imageModels: [],
  discoveredTextModels: [],
  discoveredImageModels: [],
};

export function hasModelOption(modelId: string | undefined, options: GeminiModelOption[]): boolean {
  return Boolean(modelId) && options.some((option) => option.modelId === modelId);
}

export function resolveSelectedModel(
  selectedModel: string | undefined,
  options: GeminiModelOption[]
): string {
  if (hasModelOption(selectedModel, options)) {
    return selectedModel!;
  }

  return options[0]?.modelId ?? '';
}

export function resolveActiveModeModel(
  chatModel: string | undefined,
  globalModel: string | undefined,
  options: GeminiModelOption[]
): string {
  if (hasModelOption(chatModel, options)) {
    return chatModel!;
  }

  return resolveSelectedModel(globalModel, options);
}

export function getModelSelectorPlaceholder(catalog: GeminiModelCatalogResponse): string {
  if (catalog.status === 'loading') {
    return 'Loading models...';
  }

  if (catalog.status === 'error') {
    return 'Models unavailable';
  }

  return 'No models available';
}
