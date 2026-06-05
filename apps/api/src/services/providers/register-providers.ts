import { anthropicProvider } from './anthropic/index';
import { registerProvider } from './core/provider-registry';
import { deepSeekProvider } from './deepseek/index';
import { geminiProvider } from './gemini/index';
import { openAIProvider } from './openai/index';
import { openAICompatibleProvider } from './openai-compatible/index';

/** Registers all bundled AI providers. // Usage: registerProviders() */
export function registerProviders(): void {
  registerProvider(anthropicProvider);
  registerProvider(deepSeekProvider);
  registerProvider(geminiProvider);
  registerProvider(openAIProvider);
  registerProvider(openAICompatibleProvider);
}
