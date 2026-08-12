import type {
  ProviderCacheMetrics,
  ProviderCacheName,
  ProviderDeprecationMetrics,
  ProviderObservabilityLogEntry,
  ProviderObservabilityLogsResponse,
  ProviderObservabilityMetrics,
  ProviderObservabilityMetricsResponse,
  ProviderProbeMetrics,
  ProviderProbeOperation,
  ProviderUsageKind,
  ProviderUsageMetrics,
} from '@mangostudio/shared/observability';
import type { ProviderType } from '@mangostudio/shared/types';
import { getDb } from '../../../db/database';

const MAX_LOG_ENTRIES = 200;
const PERSIST_DEBOUNCE_MS = 5_000;
const SNAPSHOT_ROW_ID = 'observability-state';
const CACHE_ORDER: ReadonlyArray<ProviderCacheName> = [
  'sdk-client',
  'prepared-runtime',
  'provider-route',
];
const PROBE_OPERATION_ORDER: ReadonlyArray<ProviderProbeOperation> = ['healthcheck', 'model-list'];

interface MutableCacheMetrics {
  hits: number;
  misses: number;
}

interface MutableUsageMetrics {
  textTurns: number;
  imageGenerations: number;
  inputTokens: number;
  lastUsedAt: number | undefined;
}

interface MutableProviderMetrics {
  caches: Map<ProviderCacheName, MutableCacheMetrics>;
  probeTimeouts: Map<ProviderProbeOperation, number>;
  usage: MutableUsageMetrics;
  /** Absent until the deprecation guard refuses a turn for this provider. */
  deprecation: ProviderDeprecationMetrics | undefined;
}

interface PersistedUsageMetrics {
  textTurns: number;
  imageGenerations: number;
  inputTokens: number;
  lastUsedAt?: number;
}

interface PersistedSnapshot {
  version: number;
  nextLogId: number;
  providerMetrics: Array<{
    provider: ProviderType;
    caches: Array<[ProviderCacheName, MutableCacheMetrics]>;
    probeTimeouts: Array<[ProviderProbeOperation, number]>;
    usage?: PersistedUsageMetrics;
    deprecation?: ProviderDeprecationMetrics;
  }>;
  recentLogs: ProviderObservabilityLogEntry[];
}

function createEmptyUsageMetrics(): MutableUsageMetrics {
  return { textTurns: 0, imageGenerations: 0, inputTokens: 0, lastUsedAt: undefined };
}

const providerMetrics = new Map<ProviderType, MutableProviderMetrics>();
const recentLogs: ProviderObservabilityLogEntry[] = [];
let nextLogId = 0;
let persistedNextLogId = 0;
let pendingFlush: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

function schedulePersist(): void {
  if (pendingFlush) {
    return;
  }

  pendingFlush = setTimeout(() => {
    pendingFlush = undefined;
    void persistSnapshot();
  }, PERSIST_DEBOUNCE_MS);
}

function markDirty(): void {
  dirty = true;
  schedulePersist();
}

function toPersistedSnapshot(): PersistedSnapshot {
  return {
    version: 1,
    nextLogId,
    providerMetrics: Array.from(providerMetrics.entries()).map(([provider, metrics]) => ({
      provider,
      caches: Array.from(metrics.caches.entries()),
      probeTimeouts: Array.from(metrics.probeTimeouts.entries()),
      usage: {
        textTurns: metrics.usage.textTurns,
        imageGenerations: metrics.usage.imageGenerations,
        inputTokens: metrics.usage.inputTokens,
        ...(metrics.usage.lastUsedAt !== undefined ? { lastUsedAt: metrics.usage.lastUsedAt } : {}),
      },
      ...(metrics.deprecation ? { deprecation: metrics.deprecation } : {}),
    })),
    recentLogs: [...recentLogs],
  };
}

function fromPersistedSnapshot(snapshot: PersistedSnapshot): void {
  providerMetrics.clear();
  recentLogs.length = 0;

  nextLogId = snapshot.nextLogId;
  persistedNextLogId = snapshot.nextLogId;

  for (const entry of snapshot.providerMetrics) {
    const restored: MutableProviderMetrics = {
      caches: new Map(entry.caches),
      probeTimeouts: new Map(entry.probeTimeouts),
      usage: entry.usage
        ? {
            textTurns: entry.usage.textTurns,
            imageGenerations: entry.usage.imageGenerations,
            inputTokens: entry.usage.inputTokens,
            lastUsedAt: entry.usage.lastUsedAt,
          }
        : createEmptyUsageMetrics(),
      deprecation: entry.deprecation,
    };
    providerMetrics.set(entry.provider, restored);
  }

  recentLogs.push(...snapshot.recentLogs);
}

async function persistSnapshot(): Promise<void> {
  if (!dirty) {
    return;
  }

  try {
    const db = getDb();
    const json = JSON.stringify(toPersistedSnapshot());

    await db
      .insertInto('observability_snapshot')
      .values({
        id: SNAPSHOT_ROW_ID,
        snapshotJson: json,
        updatedAt: Date.now(),
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ snapshotJson: json, updatedAt: Date.now() })
      )
      .execute();

    dirty = false;
  } catch {
    // Persistence is best-effort; in-memory counters remain authoritative.
  }
}

export async function loadObservabilitySnapshot(): Promise<void> {
  try {
    const db = getDb();
    const row = await db
      .selectFrom('observability_snapshot')
      .select('snapshotJson')
      .where('id', '=', SNAPSHOT_ROW_ID)
      .executeTakeFirst();

    if (row) {
      const parsed = JSON.parse(row.snapshotJson) as PersistedSnapshot;
      if (parsed.version === 1) {
        fromPersistedSnapshot(parsed);
      }
    }
  } catch {
    // Missing table or malformed JSON means start fresh.
  }
}

export function flushObservabilitySnapshot(): Promise<void> {
  if (pendingFlush) {
    clearTimeout(pendingFlush);
    pendingFlush = undefined;
  }

  return persistSnapshot();
}

function ensureProviderMetrics(provider: ProviderType): MutableProviderMetrics {
  const existing = providerMetrics.get(provider);
  if (existing) {
    return existing;
  }

  const created: MutableProviderMetrics = {
    caches: new Map(),
    probeTimeouts: new Map(),
    usage: createEmptyUsageMetrics(),
    deprecation: undefined,
  };
  providerMetrics.set(provider, created);
  return created;
}

function ensureCacheMetrics(
  provider: ProviderType,
  cacheName: ProviderCacheName
): MutableCacheMetrics {
  const metrics = ensureProviderMetrics(provider);
  const existing = metrics.caches.get(cacheName);
  if (existing) {
    return existing;
  }

  const created: MutableCacheMetrics = { hits: 0, misses: 0 };
  metrics.caches.set(cacheName, created);
  return created;
}

function appendLog(entry: Omit<ProviderObservabilityLogEntry, 'id'>): void {
  recentLogs.unshift({
    id: String(++nextLogId),
    ...entry,
  });

  if (recentLogs.length > MAX_LOG_ENTRIES) {
    recentLogs.length = MAX_LOG_ENTRIES;
  }
}

export function recordProviderCacheHit(provider: ProviderType, cacheName: ProviderCacheName): void {
  ensureCacheMetrics(provider, cacheName).hits += 1;
  markDirty();
}

export function recordProviderCacheMiss(
  provider: ProviderType,
  cacheName: ProviderCacheName
): void {
  ensureCacheMetrics(provider, cacheName).misses += 1;
  markDirty();
}

export function recordProviderProbeTimeout(input: {
  provider: ProviderType;
  operation: ProviderProbeOperation;
  message: string;
}): void {
  const metrics = ensureProviderMetrics(input.provider);
  metrics.probeTimeouts.set(input.operation, (metrics.probeTimeouts.get(input.operation) ?? 0) + 1);

  appendLog({
    timestamp: Date.now(),
    provider: input.provider,
    kind: 'probe-timeout',
    operation: input.operation,
    message: input.message,
  });

  markDirty();
}

/**
 * Record a completed provider turn so usage counters stay in sync with traffic
 * mangostudio itself generated. Fire-and-forget: this only mutates in-memory
 * counters and schedules a debounced snapshot flush, so a failure here can never
 * block or slow a generation.
 *
 * // Usage: recordProviderTurn({ provider: 'openai', kind: 'text', inputTokens: 1234 });
 */
export function recordProviderTurn(input: {
  provider: ProviderType;
  kind: ProviderUsageKind;
  inputTokens?: number;
}): void {
  const metrics = ensureProviderMetrics(input.provider);
  if (input.kind === 'text') {
    metrics.usage.textTurns += 1;
  } else {
    metrics.usage.imageGenerations += 1;
  }
  if (input.inputTokens !== undefined && input.inputTokens > 0) {
    metrics.usage.inputTokens += input.inputTokens;
  }
  metrics.usage.lastUsedAt = Date.now();
  markDirty();
}

/**
 * Record a turn the deprecation guard refused.
 *
 * This is the whole telemetry story for a deprecation: a counter that a
 * maintainer can read before deciding the window has elapsed. It rides the
 * observability snapshot that already exists rather than opening a reporting
 * channel — nothing here leaves the machine.
 *
 * // Usage: recordDeprecatedProviderAttempt({ provider: 'cursor', modelId: 'cursor/auto' });
 */
export function recordDeprecatedProviderAttempt(input: {
  provider: ProviderType;
  modelId?: string;
}): void {
  const metrics = ensureProviderMetrics(input.provider);
  metrics.deprecation = {
    refusedTurns: (metrics.deprecation?.refusedTurns ?? 0) + 1,
    lastAttemptedAt: Date.now(),
    ...(input.modelId ? { lastModelId: input.modelId } : {}),
  };
  markDirty();
}

function toProviderCacheMetrics(
  cacheName: ProviderCacheName,
  metrics: MutableCacheMetrics
): ProviderCacheMetrics {
  const total = metrics.hits + metrics.misses;
  return {
    cacheName,
    hits: metrics.hits,
    misses: metrics.misses,
    hitRate: total === 0 ? 0 : metrics.hits / total,
  };
}

function toProviderProbeMetrics(
  operation: ProviderProbeOperation,
  timeoutCount: number
): ProviderProbeMetrics {
  return {
    operation,
    timeoutCount,
  };
}

function toProviderUsageMetrics(metrics: MutableUsageMetrics): ProviderUsageMetrics | undefined {
  const { textTurns, imageGenerations, inputTokens, lastUsedAt } = metrics;
  if (textTurns === 0 && imageGenerations === 0 && inputTokens === 0) {
    return undefined;
  }
  return {
    textTurns,
    imageGenerations,
    inputTokens,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
  };
}

function toProviderObservabilityMetrics(
  provider: ProviderType,
  metrics: MutableProviderMetrics
): ProviderObservabilityMetrics {
  const caches = CACHE_ORDER.map((cacheName) => {
    const cacheMetrics = metrics.caches.get(cacheName);
    return toProviderCacheMetrics(cacheName, cacheMetrics ?? { hits: 0, misses: 0 });
  });

  const probeTimeouts = PROBE_OPERATION_ORDER.map((operation) =>
    toProviderProbeMetrics(operation, metrics.probeTimeouts.get(operation) ?? 0)
  );

  const usage = toProviderUsageMetrics(metrics.usage);

  return {
    provider,
    totalProbeTimeouts: probeTimeouts.reduce((total, item) => total + item.timeoutCount, 0),
    caches,
    probeTimeouts,
    ...(usage !== undefined ? { usage } : {}),
    ...(metrics.deprecation ? { deprecatedAttempts: metrics.deprecation } : {}),
  };
}

export function getProviderObservabilityMetrics(): ProviderObservabilityMetricsResponse {
  const providers = Array.from(providerMetrics.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, metrics]) => toProviderObservabilityMetrics(provider, metrics));

  return {
    generatedAt: Date.now(),
    providers,
  };
}

export function getProviderObservabilityLogs(
  limit = MAX_LOG_ENTRIES
): ProviderObservabilityLogsResponse {
  return {
    generatedAt: Date.now(),
    entries: recentLogs.slice(0, limit),
  };
}

export function resetProviderObservability(): void {
  providerMetrics.clear();
  recentLogs.length = 0;
  nextLogId = persistedNextLogId;
  dirty = true;

  schedulePersist();
}
