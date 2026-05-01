import type { DeepSeekLanguageModelOptions } from '@ai-sdk/deepseek';
import type { GenerationConfig } from '../types';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function normalizeDeepSeekBaseUrl(baseUrl: string | null | undefined): string {
  return baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_DEEPSEEK_BASE_URL;
}

export function buildDeepSeekProviderOptions(
  config: GenerationConfig | undefined
): { deepseek: DeepSeekLanguageModelOptions } | undefined {
  if (!config?.thinkingEnabled) return undefined;

  return {
    deepseek: {
      thinking: { type: 'enabled' },
    } satisfies DeepSeekLanguageModelOptions,
  };
}
