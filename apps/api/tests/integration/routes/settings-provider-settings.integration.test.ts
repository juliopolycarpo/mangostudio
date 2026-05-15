import { afterEach, describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { settingsRoutes } from '../../../src/routes/settings';
import { getDb } from '../../../src/db/database';
import {
  ProviderSettingsDescriptorSchema,
  ProviderSettingsListResponseSchema,
} from '@mangostudio/shared/provider-settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'provider-settings-user',
  name: 'Provider Settings User',
  email: 'provider-settings@mangostudio.test',
};

const OTHER_USER = {
  id: 'provider-settings-other-user',
  name: 'Other Provider Settings User',
  email: 'other-provider-settings@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('settings provider settings routes', () => {
  it('lists descriptors for registered providers', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/providers'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(Value.Check(ProviderSettingsListResponseSchema, payload)).toBe(true);
    expect((payload as { providers: unknown[] }).providers.length).toBeGreaterThan(0);
  });

  it('persists provider settings per user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const update = await app.handle(
      new Request('http://localhost/settings/providers/deepseek', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasoningEffort: 'max', maxToolIterations: 1_000 }),
      })
    );
    const updatedPayload = await update.json();

    expect(update.status).toBe(200);
    expect(Value.Check(ProviderSettingsDescriptorSchema, updatedPayload)).toBe(true);
    expect(updatedPayload).toMatchObject({
      settings: { provider: 'deepseek', reasoningEffort: 'max', maxToolIterations: 1_000 },
    });

    restoreAuth?.();
    const other = createAuthenticatedApiTestApp(OTHER_USER, settingsRoutes);
    restoreAuth = other.restore;

    const otherResponse = await other.app.handle(
      new Request('http://localhost/settings/providers/deepseek')
    );
    const otherPayload = await otherResponse.json();

    expect(otherResponse.status).toBe(200);
    expect(otherPayload).toMatchObject({ settings: { reasoningEffort: 'high' } });
  });

  it('normalizes malformed persisted JSON to provider defaults', async () => {
    await getDb()
      .insertInto('user_provider_settings')
      .values({
        id: 'malformed-provider-settings-row',
        userId: 'malformed-provider-settings-user',
        provider: 'deepseek',
        settingsJson: '{bad-json',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(
      {
        id: 'malformed-provider-settings-user',
        name: 'Malformed User',
        email: 'malformed-provider-settings@mangostudio.test',
      },
      settingsRoutes
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/providers/deepseek'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ settings: { provider: 'deepseek', reasoningEffort: 'high' } });
  });

  it('returns a typed validation error for unknown providers', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/providers/unknown'));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({ code: 'VALIDATION' });
  });
});
