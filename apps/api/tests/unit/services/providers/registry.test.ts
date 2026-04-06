import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  registerProvider,
  getProvider,
  clearRegistry,
  listRegisteredProviderTypes,
} from '../../../../src/services/providers/registry';
import type { AIProvider } from '../../../../src/services/providers/types';

function makeStubProvider(type: 'gemini' | 'openai-compatible' | 'anthropic'): AIProvider {
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
  };
}

describe('provider registry', () => {
  let snapshot: AIProvider[];

  beforeEach(() => {
    snapshot = listRegisteredProviderTypes().map((type) => getProvider(type));
    clearRegistry();
  });

  afterEach(() => {
    clearRegistry();
    snapshot.forEach((p) => registerProvider(p));
  });

  it('registers and retrieves a provider by type', () => {
    const stub = makeStubProvider('gemini');
    registerProvider(stub);
    expect(getProvider('gemini')).toBe(stub);
  });

  it('throws when a provider has not been registered', () => {
    expect(() => getProvider('anthropic')).toThrow("AI provider 'anthropic' is not registered.");
  });

  it('replaces an existing registration when the same type is re-registered', () => {
    const first = makeStubProvider('gemini');
    const second = makeStubProvider('gemini');
    registerProvider(first);
    registerProvider(second);
    expect(getProvider('gemini')).toBe(second);
  });
});
