import { describe, expect, it, afterEach } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { clearGeminiModelCatalog } from '../../../src/services/gemini';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'test-user-integration',
  name: 'Test User',
  email: 'test@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

const GeminiModelCatalogSchema = Type.Object({
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

describe('settingsRoutes', () => {
  it('retorna o snapshot do catálogo de modelos Gemini com shape correto', async () => {
    clearGeminiModelCatalog(TEST_USER.id);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/models/gemini'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as any;
    expect(Value.Check(GeminiModelCatalogSchema, payload)).toBe(true);
    // Cold-start now awaits refresh — status must not be 'idle'
    expect(payload.status).not.toBe('idle');
    expect(Array.isArray(payload.allModels)).toBe(true);
  });
});
