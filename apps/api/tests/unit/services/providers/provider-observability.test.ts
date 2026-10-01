import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  flushObservabilitySnapshot,
  getProviderObservabilityLogs,
  getProviderObservabilityMetrics,
  loadObservabilitySnapshot,
  recordProviderCacheHit,
  recordProviderCacheMiss,
  recordProviderProbeTimeout,
  recordProviderTurn,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';

afterEach(() => {
  resetProviderObservability();
  void flushObservabilitySnapshot();
});

beforeEach(() => {
  resetProviderObservability();
});

describe('provider observability store', () => {
  it('aggregates cache hit rate and probe timeout counters per provider', () => {
    recordProviderCacheMiss('openai', 'sdk-client');
    recordProviderCacheHit('openai', 'sdk-client');
    recordProviderCacheHit('openai', 'sdk-client');
    recordProviderProbeTimeout({
      provider: 'openai',
      operation: 'healthcheck',
      message: 'OpenAI API validation timed out.',
    });

    const metrics = getProviderObservabilityMetrics();

    expect(metrics.providers).toHaveLength(1);
    expect(metrics.providers[0]).toMatchObject({
      provider: 'openai',
      totalProbeTimeouts: 1,
    });
    expect(
      metrics.providers[0]?.caches.find((entry) => entry.cacheName === 'sdk-client')
    ).toMatchObject({
      hits: 2,
      misses: 1,
      hitRate: 2 / 3,
    });
    expect(
      metrics.providers[0]?.probeTimeouts.find((entry) => entry.operation === 'healthcheck')
    ).toMatchObject({ timeoutCount: 1 });
  });

  it('stores recent timeout logs in reverse chronological order', () => {
    recordProviderProbeTimeout({
      provider: 'gemini',
      operation: 'model-list',
      message: 'Gemini model listing timed out.',
    });
    recordProviderProbeTimeout({
      provider: 'openai-compatible',
      operation: 'healthcheck',
      message: 'OpenAI-compatible healthcheck timed out.',
    });

    const logs = getProviderObservabilityLogs();

    expect(logs.entries).toHaveLength(2);
    expect(logs.entries[0]).toMatchObject({
      provider: 'openai-compatible',
      operation: 'healthcheck',
    });
    expect(logs.entries[1]).toMatchObject({
      provider: 'gemini',
      operation: 'model-list',
    });
  });

  it('counts text and image turns per provider with estimated input tokens', () => {
    recordProviderTurn({ provider: 'openai', kind: 'text', inputTokens: 1200 });
    recordProviderTurn({ provider: 'openai', kind: 'text', inputTokens: 800 });
    recordProviderTurn({ provider: 'openai', kind: 'image' });

    const metrics = getProviderObservabilityMetrics();
    const usage = metrics.providers[0]?.usage;

    expect(usage).toMatchObject({
      textTurns: 2,
      imageGenerations: 1,
      inputTokens: 2000,
    });
    expect(usage?.lastUsedAt).toBeGreaterThan(0);
  });

  it('ignores zero or undefined input token estimates', () => {
    recordProviderTurn({ provider: 'gemini', kind: 'text' });
    recordProviderTurn({ provider: 'gemini', kind: 'text', inputTokens: 0 });

    const metrics = getProviderObservabilityMetrics();
    expect(metrics.providers[0]?.usage).toMatchObject({
      textTurns: 2,
      inputTokens: 0,
    });
  });

  it('hides the usage bucket when no turns have been recorded', () => {
    recordProviderCacheHit('anthropic', 'sdk-client');

    const metrics = getProviderObservabilityMetrics();
    const provider = metrics.providers.find((entry) => entry.provider === 'anthropic');
    expect(provider?.usage).toBeUndefined();
  });

  it('survives a snapshot persist/load round-trip across a simulated restart', async () => {
    recordProviderTurn({ provider: 'openai', kind: 'text', inputTokens: 500 });
    recordProviderTurn({ provider: 'openai', kind: 'image' });
    recordProviderCacheHit('openai', 'sdk-client');

    await flushObservabilitySnapshot();

    // Simulate a process restart: the in-memory registry is repopulated from
    // the persisted snapshot row.
    await loadObservabilitySnapshot();

    const metrics = getProviderObservabilityMetrics();
    expect(metrics.providers[0]?.usage).toMatchObject({
      textTurns: 1,
      imageGenerations: 1,
      inputTokens: 500,
    });
    expect(metrics.providers[0]?.usage?.lastUsedAt).toBeGreaterThan(0);
    expect(
      metrics.providers[0]?.caches.find((entry) => entry.cacheName === 'sdk-client')
    ).toMatchObject({ hits: 1 });
  });
});

/** Reads the persisted `sdk-client` hit count for `openai-compatible`, or undefined when absent. */
async function readPersistedSdkClientHits(): Promise<number | undefined> {
  const row = await getDb()
    .selectFrom('observability_snapshot')
    .select('snapshotJson')
    .where('id', '=', 'observability-state')
    .executeTakeFirst();
  if (!row) return undefined;

  const snapshot = JSON.parse(row.snapshotJson) as {
    providerMetrics: Array<{
      provider: string;
      caches: Array<[string, { hits: number; misses: number }]>;
    }>;
  };
  const entry = snapshot.providerMetrics.find((item) => item.provider === 'openai-compatible');
  return entry?.caches.find(([name]) => name === 'sdk-client')?.[1].hits;
}

function inMemorySdkClientHits(): number | undefined {
  const provider = getProviderObservabilityMetrics().providers.find(
    (entry) => entry.provider === 'openai-compatible'
  );
  return provider?.caches.find((entry) => entry.cacheName === 'sdk-client')?.hits;
}

interface SnapshotWriteFake {
  /** Resolves once the fake has intercepted the `observability_snapshot` write. */
  reached: Promise<void>;
  /** Lets the held write continue to the real Kysely `execute()`. */
  release: () => void;
  restore: () => void;
}

/**
 * Intercepts only `insertInto('observability_snapshot')` on the real database. The write is held
 * before the real `execute()` until released, or rejected when `mode` is `fail`.
 */
function fakeSnapshotWrite(mode: 'hold' | 'fail'): SnapshotWriteFake {
  const db = getDb();
  const realInsertInto = db.insertInto.bind(db) as (table: string) => unknown;
  const held = Promise.withResolvers<void>();
  const intercepted = Promise.withResolvers<void>();

  const wrap = (builder: unknown): unknown =>
    new Proxy(builder as object, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'execute') {
          return async () => {
            intercepted.resolve();
            if (mode === 'fail') throw new Error('fake snapshot write failure');
            await held.promise;
            return value.call(target);
          };
        }
        return (...args: unknown[]) => wrap(value.apply(target, args));
      },
    });

  const spy = spyOn(db, 'insertInto').mockImplementation(((table: string) =>
    table === 'observability_snapshot'
      ? wrap(realInsertInto(table))
      : realInsertInto(table)) as never);

  return {
    reached: intercepted.promise,
    release: () => held.resolve(),
    restore: () => spy.mockRestore(),
  };
}

describe('observability snapshot flush dirty tracking', () => {
  it('persists a mutation recorded during a held write before the explicit flush resolves', async () => {
    await flushObservabilitySnapshot();
    recordProviderCacheHit('openai-compatible', 'sdk-client');

    const fake = fakeSnapshotWrite('hold');
    try {
      const firstFlush = flushObservabilitySnapshot();
      await fake.reached;
      recordProviderCacheHit('openai-compatible', 'sdk-client');
      fake.release();
      await firstFlush;
    } finally {
      fake.restore();
    }

    expect(inMemorySdkClientHits()).toBe(2);
    const persisted = await readPersistedSdkClientHits();
    expect(persisted, `expected persisted hits: 2 | received: ${persisted}`).toBe(2);
  });

  it('keeps state dirty after a failed write and retries on the next flush', async () => {
    recordProviderCacheHit('openai-compatible', 'sdk-client');
    await flushObservabilitySnapshot();

    const fake = fakeSnapshotWrite('fail');
    try {
      recordProviderCacheHit('openai-compatible', 'sdk-client');
      await flushObservabilitySnapshot();
    } finally {
      fake.restore();
    }
    const afterFailure = await readPersistedSdkClientHits();
    expect(
      afterFailure,
      `expected persisted hits after failed write: 1 | received: ${afterFailure}`
    ).toBe(1);

    await flushObservabilitySnapshot();

    const afterRetry = await readPersistedSdkClientHits();
    expect(afterRetry, `expected persisted hits after retry: 2 | received: ${afterRetry}`).toBe(2);
  });

  it('persists the newest state when a second flush starts while the first is still writing', async () => {
    await flushObservabilitySnapshot();
    recordProviderCacheHit('openai-compatible', 'sdk-client');

    const firstFlush = flushObservabilitySnapshot();
    recordProviderCacheHit('openai-compatible', 'sdk-client');
    const secondFlush = flushObservabilitySnapshot();
    await Promise.all([firstFlush, secondFlush]);

    const persisted = await readPersistedSdkClientHits();
    expect(persisted, `expected persisted hits: 2 | received: ${persisted}`).toBe(2);
  });

  it('does not keep the pre-reset snapshot as clean when a reset lands during a held write', async () => {
    await flushObservabilitySnapshot();
    recordProviderCacheHit('openai-compatible', 'sdk-client');

    const fake = fakeSnapshotWrite('hold');
    try {
      const firstFlush = flushObservabilitySnapshot();
      await fake.reached;
      resetProviderObservability();
      fake.release();
      await firstFlush;
    } finally {
      fake.restore();
    }
    await flushObservabilitySnapshot();

    const persisted = await readPersistedSdkClientHits();
    expect(
      persisted,
      `expected persisted hits after reset: undefined | received: ${persisted}`
    ).toBe(undefined);
  });
});
