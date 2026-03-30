import { describe, expect, it, afterEach } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'test-user-connectors',
  name: 'Test User',
  email: 'test-connectors@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

const ConnectorStatusSchema = Type.Object({
  connectors: Type.Array(Type.Any()),
});

const ModelCatalogSchema = Type.Object({
  configured: Type.Boolean(),
  status: Type.Union([
    Type.Literal('idle'),
    Type.Literal('loading'),
    Type.Literal('ready'),
    Type.Literal('error'),
  ]),
  allModels: Type.Array(Type.Any()),
  textModels: Type.Array(Type.Any()),
  imageModels: Type.Array(Type.Any()),
});

describe('settings connectors routes', () => {
  it('GET /settings/connectors returns empty connector list for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/connectors'));

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(payload).toMatchObject({ connectors: [] });
  });

  it('GET /settings/models returns resolved catalog for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/models'));

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(ModelCatalogSchema, payload)).toBe(true);
    // Cold-start now awaits refresh — status must not be 'idle'
    expect(payload.status).not.toBe('idle');
    // No connectors configured → no models enabled
    expect(payload.textModels).toEqual([]);
    expect(payload.imageModels).toEqual([]);
  });

  it('GET /settings/secrets/gemini (alias) returns empty connector list', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/secrets/gemini'));

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(payload).toMatchObject({ connectors: [] });
  });
});
