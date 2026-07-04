import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
