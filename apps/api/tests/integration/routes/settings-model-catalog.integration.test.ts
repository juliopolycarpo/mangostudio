import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { clearGeminiModelCatalog } from '../../../src/services/gemini';
import { createApiTestApp } from '../../support/harness/create-api-test-app';

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
  it('retorna o snapshot do catálogo de modelos Gemini', async () => {
    clearGeminiModelCatalog();

    const app = createApiTestApp(settingsRoutes);
    const response = await app.handle(new Request('http://localhost/settings/models/gemini'));

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(GeminiModelCatalogSchema, payload)).toBe(true);
    expect(payload).toMatchObject({
      configured: false,
      status: 'idle',
      allModels: [],
      textModels: [],
      imageModels: [],
    });
  });
});
