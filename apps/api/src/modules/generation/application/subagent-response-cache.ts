import type { AgentId } from '@mangostudio/shared/agents';
import type { SubagentRunResult, SubagentStatus } from './subagent-runner';

interface SubagentCachedEntry {
  readonly callId: string;
  readonly agentId?: AgentId;
  readonly agentName?: string;
  readonly status?: SubagentStatus;
  readonly partialText?: string;
  readonly result?: SubagentRunResult;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PARTIAL_TEXT_CHARS = 30_000;
const MAX_CACHE_ENTRIES = 1_000;
const PRUNE_INTERVAL_MS = 30_000;

const cache = new Map<string, SubagentCachedEntry>();
let lastPrunedAt = 0;

function now(): number {
  return Date.now();
}

/**
 * Throttled expiry sweep. Called from every cache mutation (including per-token
 * text deltas), so it must stay O(1) amortized — full sweeps run at most once
 * per PRUNE_INTERVAL_MS. A hard cap prevents unbounded growth between sweeps.
 */
function pruneIfDue(ttlMs: number): void {
  const current = now();
  if (current - lastPrunedAt < PRUNE_INTERVAL_MS && cache.size <= MAX_CACHE_ENTRIES) return;
  lastPrunedAt = current;
  const cutoff = current - ttlMs;
  for (const [key, entry] of cache) {
    if (entry.updatedAt < cutoff) cache.delete(key);
  }
  // If still over cap, drop oldest insertions (Map preserves insertion order).
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function normalizeKey(callId: string): string {
  return callId.trim();
}

function clampText(text: string): string {
  if (text.length <= MAX_PARTIAL_TEXT_CHARS) return text;
  return text.slice(0, MAX_PARTIAL_TEXT_CHARS);
}

export function recordSubagentText(
  callId: string,
  agentId: AgentId,
  textDelta: string,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const key = normalizeKey(callId);
  if (!key) return;
  pruneIfDue(ttlMs);
  const existing = cache.get(key);
  const createdAt = existing?.createdAt ?? now();
  const partialText = clampText(`${existing?.partialText ?? ''}${textDelta}`);
  cache.set(key, {
    callId: key,
    agentId,
    agentName: existing?.agentName,
    status: existing?.status,
    partialText,
    result: existing?.result,
    createdAt,
    updatedAt: now(),
  });
}

export function recordSubagentStatus(
  callId: string,
  agentId: AgentId,
  agentName: string | undefined,
  status: SubagentStatus,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const key = normalizeKey(callId);
  if (!key) return;
  pruneIfDue(ttlMs);
  const existing = cache.get(key);
  const createdAt = existing?.createdAt ?? now();
  cache.set(key, {
    callId: key,
    agentId,
    agentName: agentName ?? existing?.agentName,
    status,
    partialText: existing?.partialText,
    result: existing?.result,
    createdAt,
    updatedAt: now(),
  });
}

export function recordSubagentResult(
  callId: string,
  result: SubagentRunResult,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const key = normalizeKey(callId);
  if (!key) return;
  pruneIfDue(ttlMs);
  const existing = cache.get(key);
  const createdAt = existing?.createdAt ?? now();
  cache.set(key, {
    callId: key,
    agentId: result.agentId,
    agentName: result.agentName,
    status: result.status,
    partialText: existing?.partialText,
    result,
    createdAt,
    updatedAt: now(),
  });
}

export function getSubagentCachedEntry(
  callId: string,
  ttlMs: number = DEFAULT_TTL_MS
): SubagentCachedEntry | undefined {
  const key = normalizeKey(callId);
  if (!key) return undefined;
  pruneIfDue(ttlMs);
  return cache.get(key);
}

export function clearSubagentCache(): void {
  cache.clear();
  lastPrunedAt = 0;
}
