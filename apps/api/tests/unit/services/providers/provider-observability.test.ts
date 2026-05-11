import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  getProviderObservabilityLogs,
  getProviderObservabilityMetrics,
  recordProviderCacheHit,
  recordProviderCacheMiss,
  recordProviderProbeTimeout,
  resetProviderObservability,
} from '../../../../src/services/providers/core/provider-observability';

afterEach(() => {
  resetProviderObservability();
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
});
