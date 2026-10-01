import { describe, expect, it } from 'bun:test';
import type { ModelCatalogResponse } from '@mangostudio/shared';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { createUnifiedModelCatalogService } from '../../../../src/services/providers/catalog';
import type { AIProvider } from '../../../../src/services/providers/types';

const MAX_CATALOG_ENTRIES = 1000;
const USER_COUNT = 2000;

const TEXT_MODEL = {
  modelId: 'gemini-2.0-flash',
  displayName: 'Gemini 2.0 Flash',
  provider: 'gemini' as const,
  capabilities: { text: true, image: false, streaming: true },
};

/** Fails with `expected <label>: <expected> | received: <actual>` so a red run names the defect. */
function expectCount(label: string, expected: number, received: number): void {
  if (received === expected) return;
  throw new Error(`expected ${label}: ${expected} | received: ${received}`);
}

function metadataRows(enabledModels: string[]): SecretMetadataRow[] {
  return [{ enabledModels: JSON.stringify(enabledModels) }] as unknown as SecretMetadataRow[];
}

function textProvider(models = [TEXT_MODEL]): AIProvider {
  return { listModels: () => Promise.resolve(models) } as unknown as AIProvider;
}

/** A promise whose resolution the test controls, plus a signal that someone is waiting on it. */
function createGate<T>() {
  const held = Promise.withResolvers<T>();
  const reached = Promise.withResolvers<void>();
  return {
    wait: () => {
      reached.resolve();
      return held.promise;
    },
    reached: reached.promise,
    release: held.resolve,
  };
}

describe('catalog snapshot entry bound', () => {
  const cases: Array<{
    name: string;
    deps: () => Parameters<typeof createUnifiedModelCatalogService>[0];
  }> = [
    {
      name: 'error path',
      deps: () => ({
        listProviders: () => [],
        listAllSecretMetadataFn: () => Promise.reject(new Error('metadata unavailable')),
      }),
    },
    {
      name: 'success path',
      deps: () => ({
        listProviders: () => ['gemini'],
        getProviderFn: () => textProvider(),
        listAllSecretMetadataFn: () => Promise.resolve(metadataRows([TEXT_MODEL.modelId])),
      }),
    },
    {
      name: 'empty-success path',
      deps: () => ({
        listProviders: () => [],
        listAllSecretMetadataFn: () => Promise.resolve([]),
      }),
    },
  ];

  for (const { name, deps } of cases) {
    it(`caps snapshots at ${MAX_CATALOG_ENTRIES} on the ${name}`, async () => {
      const snapshotStore = new Map<string, ModelCatalogResponse>();
      const service = createUnifiedModelCatalogService({ ...deps(), snapshotStore });

      for (let i = 0; i < USER_COUNT; i++) {
        await service.getUnifiedModelCatalog(`bound-user-${i}`);
      }

      expectCount('snapshots', MAX_CATALOG_ENTRIES, snapshotStore.size);
    });
  }

  it('still removes a user snapshot on explicit invalidation', async () => {
    const snapshotStore = new Map<string, ModelCatalogResponse>();
    const service = createUnifiedModelCatalogService({
      listProviders: () => [],
      listAllSecretMetadataFn: () => Promise.reject(new Error('metadata unavailable')),
      snapshotStore,
    });

    await service.getUnifiedModelCatalog('invalidate-me');
    service.invalidate('invalidate-me');

    expectCount('snapshots after invalidate', 0, snapshotStore.size);
  });
});

describe('catalog invalidated refresh', () => {
  it('does not replace a newer snapshot when an invalidated refresh settles late', async () => {
    const heldRead = createGate<SecretMetadataRow[]>();
    let metadataCalls = 0;
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => textProvider(),
      listAllSecretMetadataFn: () => {
        metadataCalls++;
        if (metadataCalls === 1) return heldRead.wait();
        return Promise.resolve(metadataRows([TEXT_MODEL.modelId]));
      },
    });

    const olderRefresh = service.refresh('late-user');
    await heldRead.reached;
    service.invalidate('late-user');

    const newer = await service.refresh('late-user');
    expectCount('enabled text models after newer refresh', 1, newer.textModels.length);

    heldRead.release(metadataRows([]));
    const older = await olderRefresh;
    // The caller of the already-started refresh still receives its own result.
    expectCount('enabled text models in older refresh result', 0, older.textModels.length);

    const current = await service.getUnifiedModelCatalog('late-user');
    expectCount('enabled text models', 1, current.textModels.length);
  });

  it('keeps the replacement in-flight promise when an invalidated refresh settles', async () => {
    const heldFirst = createGate<SecretMetadataRow[]>();
    const heldSecond = createGate<SecretMetadataRow[]>();
    let metadataCalls = 0;
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => textProvider(),
      listAllSecretMetadataFn: () => {
        metadataCalls++;
        if (metadataCalls === 1) return heldFirst.wait();
        if (metadataCalls === 2) return heldSecond.wait();
        return Promise.resolve(metadataRows([TEXT_MODEL.modelId]));
      },
    });

    const olderRefresh = service.refresh('dedupe-user');
    await heldFirst.reached;
    service.invalidate('dedupe-user');
    const replacement = service.refresh('dedupe-user');
    await heldSecond.reached;

    heldFirst.release(metadataRows([]));
    await olderRefresh;

    const joined = service.refresh('dedupe-user');
    heldSecond.release(metadataRows([TEXT_MODEL.modelId]));
    await Promise.all([replacement, joined]);

    expectCount('metadata reads', 2, metadataCalls);
  });

  it('does not repopulate the provider cache from an invalidated discovery', async () => {
    const heldDiscovery = createGate<(typeof TEXT_MODEL)[]>();
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => ({ listModels: () => heldDiscovery.wait() }) as unknown as AIProvider,
      listAllSecretMetadataFn: () => Promise.resolve(metadataRows([TEXT_MODEL.modelId])),
    });

    const olderRefresh = service.refresh('discovery-user');
    await heldDiscovery.reached;
    service.invalidate('discovery-user');
    heldDiscovery.release([TEXT_MODEL]);
    await olderRefresh;

    const cached = service.getCachedModelCapabilities('discovery-user', TEXT_MODEL.modelId);
    expect(cached).toBeUndefined();
  });
});

describe('catalog recalculation supersedes in-flight reads', () => {
  it('does not cache an older refresh whose metadata read predates recalculate()', async () => {
    const heldRead = createGate<SecretMetadataRow[]>();
    let enabled: string[] = [];
    let metadataCalls = 0;
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => textProvider(),
      listAllSecretMetadataFn: () => {
        metadataCalls++;
        if (metadataCalls === 1) return heldRead.wait();
        return Promise.resolve(metadataRows(enabled));
      },
    });

    const olderRefresh = service.refresh('recalc-user');
    await heldRead.reached;
    // The user enables a model after the older read started; that read still sees none.
    enabled = [TEXT_MODEL.modelId];
    service.recalculate('recalc-user');
    heldRead.release(metadataRows([]));
    await olderRefresh;

    const current = await service.getUnifiedModelCatalog('recalc-user');
    expectCount('enabled text models after recalculate', 1, current.textModels.length);
  });

  it('does not clear the dirty flag from a recalculation that predates recalculate()', async () => {
    const heldRead = createGate<SecretMetadataRow[]>();
    let enabled: string[] = [TEXT_MODEL.modelId];
    let metadataCalls = 0;
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => textProvider(),
      listAllSecretMetadataFn: () => {
        metadataCalls++;
        if (metadataCalls === 2) return heldRead.wait();
        return Promise.resolve(metadataRows(enabled));
      },
    });

    await service.getUnifiedModelCatalog('dirty-user');
    service.recalculate('dirty-user');
    const olderRecalc = service.getUnifiedModelCatalog('dirty-user');
    await heldRead.reached;
    enabled = [];
    service.recalculate('dirty-user');
    heldRead.release(metadataRows([TEXT_MODEL.modelId]));
    await olderRecalc;

    const current = await service.getUnifiedModelCatalog('dirty-user');
    expectCount('enabled text models after second recalculate', 0, current.textModels.length);
  });
});

describe('catalog snapshot eviction order', () => {
  it('evicts the oldest inserted snapshot and keeps the caller fresh one', async () => {
    const snapshotStore = new Map<string, ModelCatalogResponse>();
    const service = createUnifiedModelCatalogService({
      listProviders: () => [],
      listAllSecretMetadataFn: () => Promise.resolve([]),
      snapshotStore,
    });

    for (let i = 0; i < MAX_CATALOG_ENTRIES + 1; i++) {
      await service.getUnifiedModelCatalog(`order-user-${i}`);
    }

    expect(snapshotStore.has('order-user-0')).toBe(false);
    expect(snapshotStore.has(`order-user-${MAX_CATALOG_ENTRIES}`)).toBe(true);
    expectCount('snapshots', MAX_CATALOG_ENTRIES, snapshotStore.size);
  });
});

describe('catalog invalidation generation bound', () => {
  /** Invalidates enough other users to push the oldest generation entries out of the bounded map. */
  function churnInvalidations(service: { invalidate(userId: string): void }): void {
    for (let i = 0; i < MAX_CATALOG_ENTRIES + 1; i++) service.invalidate(`churn-${i}`);
  }

  it('still ignores a stale write after its invalidation entry was evicted', async () => {
    const heldRead = createGate<SecretMetadataRow[]>();
    let metadataCalls = 0;
    const snapshotStore = new Map<string, ModelCatalogResponse>();
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => textProvider(),
      listAllSecretMetadataFn: () => {
        metadataCalls++;
        if (metadataCalls === 1) return heldRead.wait();
        return Promise.resolve(metadataRows([TEXT_MODEL.modelId]));
      },
      snapshotStore,
    });

    const olderRefresh = service.refresh('evicted-user');
    await heldRead.reached;
    service.invalidate('evicted-user');
    churnInvalidations(service);
    heldRead.release(metadataRows([]));
    await olderRefresh;

    expect(snapshotStore.has('evicted-user')).toBe(false);
  });

  it('accepts a refresh that starts after its invalidation entry was evicted', async () => {
    const snapshotStore = new Map<string, ModelCatalogResponse>();
    const service = createUnifiedModelCatalogService({
      listProviders: () => ['gemini'],
      getProviderFn: () => textProvider(),
      listAllSecretMetadataFn: () => Promise.resolve(metadataRows([TEXT_MODEL.modelId])),
      snapshotStore,
    });

    service.invalidate('evicted-user');
    churnInvalidations(service);
    await service.refresh('evicted-user');

    expectCount(
      'enabled text models cached',
      1,
      snapshotStore.get('evicted-user')?.textModels.length ?? 0
    );
  });
});
