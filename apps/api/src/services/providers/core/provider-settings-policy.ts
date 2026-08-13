import {
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
} from '@mangostudio/shared/app-settings';
import type {
  ProviderRuntimeSettings,
  ProviderSettingsDescriptor,
  ReasoningPolicy,
} from '@mangostudio/shared/provider-settings';
import { isDeprecatedProvider } from '@mangostudio/shared/provider-settings';
import type { ProviderType, ReasoningEffort } from '@mangostudio/shared/types';

const PROVIDER_TYPES: ReadonlyArray<ProviderType> = [
  'gemini',
  'openai',
  'openai-compatible',
  'anthropic',
  'deepseek',
  'cursor',
  'chatgpt',
];

interface ProviderSettingsPolicy {
  displayName: string;
  reasoning: ReasoningPolicy;
  promptCachingSupported: boolean;
  toolUseSupported: boolean;
  structuredOutputSupported: boolean;
  maxOutputTokensLimit: number;
  defaults: Omit<ProviderRuntimeSettings, 'provider'>;
}

const PROVIDER_POLICIES: Record<ProviderType, ProviderSettingsPolicy> = {
  gemini: {
    displayName: 'Gemini',
    reasoning: buildReasoningPolicy(['low', 'medium', 'high'], true, true),
    promptCachingSupported: true,
    toolUseSupported: true,
    structuredOutputSupported: true,
    maxOutputTokensLimit: 65_536,
    defaults: {
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
  openai: {
    displayName: 'OpenAI',
    reasoning: buildReasoningPolicy(['low', 'medium', 'high', 'xhigh'], true, true),
    promptCachingSupported: true,
    toolUseSupported: true,
    structuredOutputSupported: true,
    maxOutputTokensLimit: 128_000,
    defaults: {
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
  'openai-compatible': {
    displayName: 'OpenAI compatible',
    reasoning: buildReasoningPolicy(['low', 'medium', 'high'], false, false),
    promptCachingSupported: false,
    toolUseSupported: true,
    structuredOutputSupported: true,
    maxOutputTokensLimit: 65_536,
    defaults: {
      thinkingEnabled: false,
      reasoningEffort: 'medium',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
  anthropic: {
    displayName: 'Anthropic',
    reasoning: buildReasoningPolicy(['low', 'medium', 'high'], true, true),
    promptCachingSupported: true,
    toolUseSupported: true,
    structuredOutputSupported: false,
    maxOutputTokensLimit: 64_000,
    defaults: {
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
  deepseek: {
    displayName: 'DeepSeek',
    reasoning: buildReasoningPolicy(['high', 'max'], true, true, 'high'),
    promptCachingSupported: false,
    toolUseSupported: true,
    structuredOutputSupported: false,
    maxOutputTokensLimit: 64_000,
    defaults: {
      thinkingEnabled: true,
      reasoningEffort: 'high',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
  cursor: {
    // Deprecated, and kept only so an existing connector and the settings it
    // already carries stay readable. Nothing here is offered for new setup.
    displayName: 'Cursor',
    reasoning: buildReasoningPolicy(['low', 'medium', 'high'], true, false),
    promptCachingSupported: false,
    toolUseSupported: true,
    structuredOutputSupported: false,
    maxOutputTokensLimit: 128_000,
    defaults: {
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
  chatgpt: {
    displayName: 'ChatGPT',
    // xhigh is offered in the UI and clamped to the backend's high on the wire.
    reasoning: buildReasoningPolicy(['low', 'medium', 'high', 'xhigh'], true, true),
    promptCachingSupported: false,
    toolUseSupported: true,
    structuredOutputSupported: false,
    // UI cap only — the adapter never sends max_output_tokens on the wire.
    maxOutputTokensLimit: 128_000,
    defaults: {
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      maxToolIterations: MAX_TOOL_ITERATIONS_DEFAULT,
    },
  },
};

function buildReasoningPolicy(
  supportedEfforts: ReadonlyArray<ReasoningEffort>,
  thinkingToggleSupported: boolean,
  reasoningWithToolsSupported: boolean,
  defaultEffort: ReasoningEffort = 'medium'
): ReasoningPolicy {
  return {
    supportedEfforts,
    defaultEffort,
    maxEffort: supportedEfforts.at(-1),
    thinkingToggleSupported,
    reasoningWithToolsSupported,
  };
}

export function isProviderType(value: string): value is ProviderType {
  return PROVIDER_TYPES.includes(value as ProviderType);
}

function getProviderSettingsPolicy(provider: ProviderType): ProviderSettingsPolicy {
  return PROVIDER_POLICIES[provider];
}

export function buildProviderSettingsDescriptor(
  provider: ProviderType,
  savedSettings?: Partial<ProviderRuntimeSettings>
): ProviderSettingsDescriptor {
  const policy = getProviderSettingsPolicy(provider);
  return {
    provider,
    displayName: policy.displayName,
    scope: 'provider',
    reasoning: policy.reasoning,
    promptCachingSupported: policy.promptCachingSupported,
    toolUseSupported: policy.toolUseSupported,
    structuredOutputSupported: policy.structuredOutputSupported,
    maxOutputTokensLimit: policy.maxOutputTokensLimit,
    settings: normalizeProviderRuntimeSettings(provider, savedSettings),
    deprecated: isDeprecatedProvider(provider),
  };
}

export function normalizeProviderRuntimeSettings(
  provider: ProviderType,
  rawSettings: Partial<ProviderRuntimeSettings> | undefined
): ProviderRuntimeSettings {
  const policy = getProviderSettingsPolicy(provider);
  const defaults = policy.defaults;
  const reasoningEffort = normalizeReasoningEffort(provider, rawSettings?.reasoningEffort);
  const maxOutputTokens = normalizePositiveInteger(
    rawSettings?.maxOutputTokens,
    policy.maxOutputTokensLimit
  );

  return {
    provider,
    thinkingEnabled: policy.reasoning.thinkingToggleSupported
      ? (rawSettings?.thinkingEnabled ?? defaults.thinkingEnabled)
      : false,
    reasoningEffort,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    maxToolIterations: normalizeToolIterations(rawSettings?.maxToolIterations),
    providerCompactionEnabled:
      rawSettings?.providerCompactionEnabled ?? defaults.providerCompactionEnabled ?? true,
    ...(policy.promptCachingSupported && rawSettings?.promptCachePreference
      ? { promptCachePreference: rawSettings.promptCachePreference }
      : {}),
    ...(rawSettings?.parallelToolCallsEnabled !== undefined && policy.toolUseSupported
      ? { parallelToolCallsEnabled: rawSettings.parallelToolCallsEnabled }
      : {}),
  };
}

export function mergeProviderRuntimeSettings(
  provider: ProviderType,
  savedSettings: Partial<ProviderRuntimeSettings> | undefined,
  requestSettings: Partial<ProviderRuntimeSettings>
): ProviderRuntimeSettings {
  return normalizeProviderRuntimeSettings(provider, {
    ...normalizeProviderRuntimeSettings(provider, savedSettings),
    ...requestSettings,
  });
}

function normalizeReasoningEffort(
  provider: ProviderType,
  effort: ReasoningEffort | undefined
): ReasoningEffort {
  const policy = getProviderSettingsPolicy(provider);
  const requested = effort ?? policy.reasoning.defaultEffort;
  if (policy.reasoning.supportedEfforts.includes(requested)) return requested;

  if (provider === 'deepseek') return requested === 'max' || requested === 'xhigh' ? 'max' : 'high';
  if (provider === 'cursor' && (requested === 'max' || requested === 'xhigh')) {
    return policy.reasoning.defaultEffort;
  }
  if (requested === 'max') return policy.reasoning.maxEffort ?? policy.reasoning.defaultEffort;
  if (requested === 'xhigh') return policy.reasoning.maxEffort ?? 'high';
  return policy.reasoning.defaultEffort;
}

function normalizeToolIterations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_TOOL_ITERATIONS_DEFAULT;
  return Math.min(MAX_TOOL_ITERATIONS_MAX, Math.max(MAX_TOOL_ITERATIONS_MIN, Math.round(value)));
}

function normalizePositiveInteger(value: number | undefined, maximum: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(1, Math.round(value as number)));
}
