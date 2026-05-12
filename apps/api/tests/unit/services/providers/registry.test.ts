import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderType } from '@mangostudio/shared/types';
import {
  getProviderForModel,
  registerProvider,
  getProvider,
  invalidateProviderRoutingCache,
  setProviderRegistryDbForTests,
} from '../../../../src/services/providers/core/provider-registry';
import {
  getProviderObservabilityMetrics,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';
import type { AIProvider } from '../../../../src/services/providers/types';
import type { getDb } from '../../../../src/db/database';

let providerTypeCounter = 0;

function createTestProviderType(label: string): ProviderType {
  providerTypeCounter += 1;
  return `test-${label}-${providerTypeCounter}` as ProviderType;
}

function createProviderRegistryDbStub(execute: () => Promise<unknown[]>) {
  return () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({ execute }),
      }),
    }),
  });
}

function makeStubProvider(type: ProviderType): AIProvider {
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
  beforeEach(() => {
    resetProviderObservability();
    setProviderRegistryDbForTests();
  });

  afterEach(() => {
    resetProviderObservability();
    setProviderRegistryDbForTests();
  });

  it('registers and retrieves a provider by type', () => {
    const providerType = createTestProviderType('lookup');
    const stub = makeStubProvider(providerType);
    registerProvider(stub);
    expect(getProvider(providerType)).toBe(stub);
  });

  it('throws when a provider has not been registered', () => {
    const providerType = createTestProviderType('missing');
    expect(() => getProvider(providerType)).toThrow(
      `AI provider '${providerType}' is not registered.`
    );
  });

  it('replaces an existing registration when the same type is re-registered', () => {
    const providerType = createTestProviderType('replace');
    const first = makeStubProvider(providerType);
    const second = makeStubProvider(providerType);
    registerProvider(first);
    registerProvider(second);
    expect(getProvider(providerType)).toBe(second);
  });

  it('caches provider routing for repeated model lookups', async () => {
    const providerType = createTestProviderType('cache');
    const modelName = `model-${providerType}`;
    const userId = `user-${providerType}`;
    let executeCount = 0;

    setProviderRegistryDbForTests(
      createProviderRegistryDbStub(() => {
        executeCount++;
        return Promise.resolve([
          {
            provider: providerType,
            enabledModels: JSON.stringify([modelName]),
          },
        ]);
      }) as unknown as typeof getDb
    );

    const stub = makeStubProvider(providerType);
    registerProvider(stub);

    const first = await getProviderForModel(modelName, userId);
    const second = await getProviderForModel(modelName, userId);

    expect(first).toBe(stub);
    expect(second).toBe(stub);
    expect(executeCount).toBe(1);
    expect(
      getProviderObservabilityMetrics()
        .providers.find((entry) => entry.provider === providerType)
        ?.caches.find((entry) => entry.cacheName === 'provider-route')
    ).toMatchObject({ hits: 1, misses: 1 });
  });

  it('clears cached routes when provider routing cache is invalidated', async () => {
    const providerType = createTestProviderType('invalidate');
    const modelName = `model-${providerType}`;
    const userId = `user-${providerType}`;
    let executeCount = 0;

    setProviderRegistryDbForTests(
      createProviderRegistryDbStub(() => {
        executeCount++;
        return Promise.resolve([
          {
            provider: providerType,
            enabledModels: JSON.stringify([modelName]),
          },
        ]);
      }) as unknown as typeof getDb
    );

    registerProvider(makeStubProvider(providerType));

    await getProviderForModel(modelName, userId);
    invalidateProviderRoutingCache(userId);
    await getProviderForModel(modelName, userId);

    expect(executeCount).toBe(2);
  });
});
