import { afterEach, describe, expect, it } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { settingsRoutes } from '../../../src/routes/settings';
import { clearGeminiModelCatalog } from '../../../src/services/gemini';
import { isProviderModelsUrl } from '../../support/connectors';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'test-user-integration',
  name: 'Test User',
  email: 'test@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;
let originalFetch: typeof globalThis.fetch = globalThis.fetch;

function installProviderModelListFetch(): void {
  originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (isProviderModelsUrl(url, 'api.openai.com')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
    }
    if (url === 'https://api.deepseek.com/models') {
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), {
        status: 200,
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  globalThis.fetch = originalFetch;
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
    installProviderModelListFetch();
    clearGeminiModelCatalog(TEST_USER.id);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/models/gemini'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as { status: string; allModels: unknown[] };
    expect(Value.Check(GeminiModelCatalogSchema, payload)).toBe(true);
    // Cold-start now awaits refresh — status must not be 'idle'
    expect(payload.status).not.toBe('idle');
    expect(Array.isArray(payload.allModels)).toBe(true);
  });
});
