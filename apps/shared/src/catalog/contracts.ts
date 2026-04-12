import type { ProviderType } from '../types/provider';

/** Runtime state of the cached model catalog. */
export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Provider capabilities for a model. */
export interface ModelCapabilities {
  text: boolean;
  image: boolean;
  streaming: boolean;
  reasoning?: boolean;
  tools?: boolean;
  statefulContinuation?: boolean;
  promptCaching?: boolean;
  parallelToolCalls?: boolean;
  reasoningWithTools?: boolean;
}

/** A UI-safe model option discovered from a provider. */
export interface ModelOption {
  modelId: string;
  resourceName: string;
  displayName: string;
  description?: string;
  version?: string;
  supportedActions: string[];
  provider?: ProviderType;
  capabilities?: ModelCapabilities;
  /** Maximum input tokens accepted by the model (from provider API). */
  inputTokenLimit?: number;
}

/** Cached model catalog returned by the API settings route. */
export interface ModelCatalogResponse {
  configured: boolean;
  status: ModelCatalogStatus;
  lastSyncedAt?: number;
  error?: string;
  allModels: ModelOption[];
  textModels: ModelOption[];
  imageModels: ModelOption[];
  discoveredTextModels: ModelOption[];
  discoveredImageModels: ModelOption[];
}
