import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderType } from '@mangostudio/shared/types';
import type { getDb } from '../../../../src/db/database';
import {
  getProviderObservabilityMetrics,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';
import { createProviderRegistryForTests } from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../../src/services/providers/types';

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
  });

  afterEach(() => {
    resetProviderObservability();
  });

  it('registers and retrieves a provider by type', () => {
    const providerType = createTestProviderType('lookup');
    const stub = makeStubProvider(providerType);
    const registry = createProviderRegistryForTests();
    registry.registerProvider(stub);
    expect(registry.getProvider(providerType)).toBe(stub);
  });

  it('throws when a provider has not been registered', () => {
    const providerType = createTestProviderType('missing');
    const registry = createProviderRegistryForTests();
    expect(() => registry.getProvider(providerType)).toThrow(
      `AI provider '${providerType}' is not registered.`
    );
  });

  it('replaces an existing registration when the same type is re-registered', () => {
    const providerType = createTestProviderType('replace');
    const first = makeStubProvider(providerType);
    const second = makeStubProvider(providerType);
    const registry = createProviderRegistryForTests();
    registry.registerProvider(first);
    registry.registerProvider(second);
    expect(registry.getProvider(providerType)).toBe(second);
  });

  it('caches provider routing for repeated model lookups', async () => {
    const providerType = createTestProviderType('cache');
    const modelName = `model-${providerType}`;
    const userId = `user-${providerType}`;
    let executeCount = 0;
    const registry = createProviderRegistryForTests(
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
    registry.registerProvider(stub);

    const first = await registry.getProviderForModel(modelName, userId);
    const second = await registry.getProviderForModel(modelName, userId);

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
    const registry = createProviderRegistryForTests(
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

    registry.registerProvider(makeStubProvider(providerType));

    await registry.getProviderForModel(modelName, userId);
    registry.invalidateProviderRoutingCache(userId);
    await registry.getProviderForModel(modelName, userId);

    expect(executeCount).toBe(2);
  });
});
