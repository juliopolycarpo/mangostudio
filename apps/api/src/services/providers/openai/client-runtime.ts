import type OpenAI from 'openai';
import type { ProviderWarmupRequest } from '../types';

export interface OpenAIClientRuntime<Config> {
  readonly config: Config;
  readonly client: OpenAI;
}

export function createOpenAIClientRuntimeLoader<Config>(
  resolveConfig: (userId: string, modelName?: string) => Promise<Config>,
  createClient: (config: Config) => OpenAI
): (userId: string, modelName?: string) => Promise<OpenAIClientRuntime<Config>> {
  return async (userId, modelName) => {
    const config = await resolveConfig(userId, modelName);
    return {
      config,
      client: createClient(config),
    };
  };
}

export interface OpenAIProviderLifecycleHandlers {
  invalidateModelCache(userId?: string): void;
  syncConfigFileConnectors(userId: string): Promise<void>;
  warmup(req: ProviderWarmupRequest): Promise<void>;
}

export function createOpenAIProviderLifecycleHandlers(
  lifecycle: OpenAIProviderLifecycleHandlers
): OpenAIProviderLifecycleHandlers {
  return {
    invalidateModelCache: lifecycle.invalidateModelCache,
    syncConfigFileConnectors: lifecycle.syncConfigFileConnectors,
    warmup: lifecycle.warmup,
  };
}
