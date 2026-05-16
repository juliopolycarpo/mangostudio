import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  healthcheckProviderConnection,
  warmProviderForRequest,
} from '../../../../src/services/providers/core/provider-readiness';
import {
  clearRegistry,
  getProvider,
  listRegisteredProviderTypes,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AIProvider,
  ProviderHealthcheckRequest,
} from '../../../../src/services/providers/types';

const moduleSnapshot: AIProvider[] = listRegisteredProviderTypes().map((type) => getProvider(type));

function makeStubProvider(
  type: 'gemini' | 'openai-compatible' | 'anthropic' | 'deepseek' | 'openai',
  overrides: Partial<AIProvider> = {}
): AIProvider {
  return {
    providerType: type,
    generateText() {
      return Promise.resolve({ text: 'stub' });
    },
    listModels() {
      return Promise.resolve([]);
    },
    validateApiKey() {
      return Promise.resolve();
    },
    resolveApiKey() {
      return Promise.resolve('stub-key');
    },
    ...overrides,
  };
}

describe('provider readiness', () => {
  beforeEach(() => {
    clearRegistry();
    for (const provider of moduleSnapshot) {
      registerProvider(provider);
    }
  });

  afterEach(() => {
    clearRegistry();
    for (const provider of moduleSnapshot) {
      registerProvider(provider);
    }
  });

  it('forwards warmup requests to the provider strategy', async () => {
    const warmup = mock(() => Promise.resolve());
    registerProvider(makeStubProvider('gemini', { warmup }));

    await warmProviderForRequest('gemini', {
      userId: 'user-1',
      modelName: 'gemini-2.5-flash',
      purpose: 'stream-text',
    });

    expect(warmup).toHaveBeenCalledWith({
      userId: 'user-1',
      modelName: 'gemini-2.5-flash',
      purpose: 'stream-text',
    });
  });

  it('swallows warmup failures so runtime requests can continue', async () => {
    registerProvider(
      makeStubProvider('gemini', {
        warmup: () => Promise.reject(new Error('transient warmup failure')),
      })
    );

    const result = await warmProviderForRequest('gemini', {
      userId: 'user-1',
      modelName: 'gemini-2.5-flash',
      purpose: 'agent-turn',
    });

    expect(result).toBeUndefined();
  });

  it('prefers provider healthcheck over validateApiKey', async () => {
    const healthcheck = mock((_request: ProviderHealthcheckRequest) => Promise.resolve());
    const validateApiKey = mock(() => Promise.resolve());
    registerProvider(makeStubProvider('openai', { healthcheck, validateApiKey }));

    await healthcheckProviderConnection('openai', {
      apiKey: 'sk-test',
      organizationId: 'org-1',
      projectId: 'proj-1',
    });

    expect(healthcheck).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      organizationId: 'org-1',
      projectId: 'proj-1',
    });
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('falls back to validateApiKey when a provider has no healthcheck strategy', async () => {
    const validateApiKey = mock(() => Promise.resolve());
    registerProvider(makeStubProvider('anthropic', { validateApiKey }));

    await healthcheckProviderConnection('anthropic', { apiKey: 'sk-test' });

    expect(validateApiKey).toHaveBeenCalledWith('sk-test');
  });
});
