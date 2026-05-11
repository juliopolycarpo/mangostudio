import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  clearRegistry,
  getProviderForModel,
  registerProvider,
  getProvider,
  invalidateProviderRoutingCache,
  listRegisteredProviderTypes,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../../src/services/providers/types';
import { getDb } from '../../../../src/db/database';

function makeStubProvider(
  type: 'gemini' | 'openai-compatible' | 'anthropic' | 'deepseek'
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

  afterEach(async () => {
    mock.restore();
    await mock.module('../../../../src/db/database', () => ({ getDb }));
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

  it('caches provider routing for repeated model lookups', async () => {
    let executeCount = 0;

    await mock.module('../../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              execute: () => {
                executeCount++;
                return Promise.resolve([
                  {
                    provider: 'gemini',
                    enabledModels: JSON.stringify(['gemini-2.5-flash']),
                  },
                ]);
              },
            }),
          }),
        }),
      }),
    }));

    const stub = makeStubProvider('gemini');
    registerProvider(stub);

    const first = await getProviderForModel('gemini-2.5-flash', 'user-1');
    const second = await getProviderForModel('gemini-2.5-flash', 'user-1');

    expect(first).toBe(stub);
    expect(second).toBe(stub);
    expect(executeCount).toBe(1);
  });

  it('clears cached routes when provider routing cache is invalidated', async () => {
    let executeCount = 0;

    await mock.module('../../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              execute: () => {
                executeCount++;
                return Promise.resolve([
                  {
                    provider: 'gemini',
                    enabledModels: JSON.stringify(['gemini-2.5-flash']),
                  },
                ]);
              },
            }),
          }),
        }),
      }),
    }));

    registerProvider(makeStubProvider('gemini'));

    await getProviderForModel('gemini-2.5-flash', 'user-1');
    invalidateProviderRoutingCache('user-1');
    await getProviderForModel('gemini-2.5-flash', 'user-1');

    expect(executeCount).toBe(2);
  });
});
