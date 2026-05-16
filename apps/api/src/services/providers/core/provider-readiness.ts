import type { ProviderType } from '@mangostudio/shared/types';
import type { ProviderHealthcheckRequest, ProviderWarmupRequest } from '../types';
import { getProvider } from './provider-registry';

function requireApiKey(provider: ProviderType, request: ProviderHealthcheckRequest): string {
  if (!request.apiKey?.trim()) {
    throw new Error(`${provider} healthcheck requires an API key.`);
  }

  return request.apiKey.trim();
}

export async function warmProviderForRequest(
  providerType: ProviderType,
  request: ProviderWarmupRequest
): Promise<void> {
  const provider = getProvider(providerType);
  if (!provider.warmup) {
    return;
  }

  try {
    await provider.warmup(request);
  } catch {
    // Warmup is a latency optimization only; runtime execution must still decide
    // whether the provider is actually usable when the real request is made.
  }
}

export async function healthcheckProviderConnection(
  providerType: ProviderType,
  request: ProviderHealthcheckRequest
): Promise<void> {
  const provider = getProvider(providerType);
  if (provider.healthcheck) {
    await provider.healthcheck(request);
    return;
  }

  await provider.validateApiKey(requireApiKey(providerType, request));
}
