import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  ProviderObservabilityLogsResponse,
  ProviderObservabilityMetricsResponse,
} from '@mangostudio/shared/observability';
import { settingsRoutes } from '../../../src/routes/settings';
import {
  recordProviderCacheHit,
  recordProviderCacheMiss,
  recordProviderProbeTimeout,
  recordProviderTurn,
  resetProviderObservability,
} from '../../../src/services/providers/core/provider-observability';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'observability-user',
  name: 'Observability User',
  email: 'observability@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  resetProviderObservability();
});

beforeEach(() => {
  resetProviderObservability();
});

describe('settings observability routes', () => {
  it('returns live provider metrics', async () => {
    recordProviderCacheMiss('openai', 'sdk-client');
    recordProviderCacheHit('openai', 'sdk-client');
    recordProviderProbeTimeout({
      provider: 'openai',
      operation: 'healthcheck',
      message: 'OpenAI API validation timed out.',
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/metrics'));
    const payload = (await response.json()) as ProviderObservabilityMetricsResponse;

    expect(response.status).toBe(200);
    expect(payload.providers[0]).toMatchObject({
      provider: 'openai',
      totalProbeTimeouts: 1,
    });
  });

  it('returns recent timeout logs', async () => {
    recordProviderProbeTimeout({
      provider: 'gemini',
      operation: 'model-list',
      message: 'Gemini model listing timed out.',
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/logs'));
    const payload = (await response.json()) as ProviderObservabilityLogsResponse;

    expect(response.status).toBe(200);
    expect(payload.entries[0]).toMatchObject({
      provider: 'gemini',
      operation: 'model-list',
      kind: 'probe-timeout',
    });
  });

  it('exposes per-provider usage counters after a recorded turn', async () => {
    recordProviderTurn({ provider: 'openai', kind: 'text', inputTokens: 900 });
    recordProviderTurn({ provider: 'openai', kind: 'image' });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/metrics'));
    const payload = (await response.json()) as ProviderObservabilityMetricsResponse;

    expect(response.status).toBe(200);
    expect(payload.providers[0]?.usage).toMatchObject({
      textTurns: 1,
      imageGenerations: 1,
      inputTokens: 900,
    });
  });

  it('omits the usage bucket for providers that were never used', async () => {
    recordProviderCacheHit('anthropic', 'sdk-client');

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/metrics'));
    const payload = (await response.json()) as ProviderObservabilityMetricsResponse;

    expect(response.status).toBe(200);
    expect(payload.providers[0]?.usage).toBeUndefined();
  });
});
