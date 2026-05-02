import type { ProviderType, ReasoningEffort } from '../types/provider';

export type ProviderSettingScope = 'provider';

export type PromptCachePreference = 'auto' | 'stable-prefix' | 'off';

export interface ReasoningPolicy {
  supportedEfforts: ReadonlyArray<ReasoningEffort>;
  defaultEffort: ReasoningEffort;
  maxEffort?: ReasoningEffort;
  thinkingToggleSupported: boolean;
  reasoningWithToolsSupported: boolean;
}

export interface ProviderRuntimeSettings {
  provider: ProviderType;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  maxToolIterations?: number;
  providerCompactionEnabled?: boolean;
  promptCachePreference?: PromptCachePreference;
  parallelToolCallsEnabled?: boolean;
}

export interface ProviderSettingsDescriptor {
  provider: ProviderType;
  displayName: string;
  scope: ProviderSettingScope;
  reasoning: ReasoningPolicy;
  promptCachingSupported: boolean;
  toolUseSupported: boolean;
  structuredOutputSupported: boolean;
  maxOutputTokensLimit: number;
  settings: ProviderRuntimeSettings;
}

export interface ProviderSettingsListResponse {
  providers: ProviderSettingsDescriptor[];
}
