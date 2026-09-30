import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared';
import { isDeprecatedModelId } from '@mangostudio/shared/provider-settings';

export const EMPTY_MODEL_CATALOG: ModelCatalogResponse = {
  configured: false,
  status: 'idle',
  allModels: [],
  textModels: [],
  imageModels: [],
  discoveredTextModels: [],
  discoveredImageModels: [],
};

/**
 * The catalog as its readers see it before the hub has answered.
 *
 * The shell no longer waits for the catalog before its first screen, so there
 * is a window where the composer is up without it. Reported as `loading`
 * rather than as the idle empty catalog: the model selector then reads
 * "Loading models" and stays disabled, instead of claiming there are none.
 *
 * @example getModelSelectorPlaceholder(LOADING_MODEL_CATALOG, labels) // labels.loading
 */
export const LOADING_MODEL_CATALOG: ModelCatalogResponse = {
  ...EMPTY_MODEL_CATALOG,
  status: 'loading',
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
  // Deprecated ids are hidden from the catalog on purpose. Keep the stored
  // value anyway: replacing it with the first live model would send a
  // different provider and skip the server's named refusal.
  if (chatModel && (hasModelOption(chatModel, options) || isDeprecatedModelId(chatModel))) {
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
