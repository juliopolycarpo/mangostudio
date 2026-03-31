import { describe, expect, it, afterEach, beforeAll, beforeEach, mock } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';
import { getProvider, registerProvider } from '../../../src/services/providers/registry';
import type { AIProvider } from '../../../src/services/providers/types';

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

/* ------------------------------------------------------------------ */
/*  OpenAI / OpenAI-compatible connector integration tests            */
/* ------------------------------------------------------------------ */

const OPENAI_CONNECTOR_USER = {
  id: 'test-user-openai-connectors',
  name: 'OpenAI Test User',
  email: 'test-openai-connectors@mangostudio.test',
};

const OPENAI_LIST_USER = {
  id: 'test-user-openai-list',
  name: 'OpenAI List User',
  email: 'test-openai-list@mangostudio.test',
};

const COMPAT_LIST_USER = {
  id: 'test-user-compat-list',
  name: 'Compat List User',
  email: 'test-compat-list@mangostudio.test',
};

const ConnectorResponseSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  provider: Type.String(),
  configured: Type.Boolean(),
  source: Type.String(),
  baseUrl: Type.Union([Type.String(), Type.Null()]),
});

describe('openai connector routes', () => {
  beforeAll(async () => {
    const db = getDb();
    const now = Date.now();
    for (const u of [OPENAI_CONNECTOR_USER, OPENAI_LIST_USER, COMPAT_LIST_USER]) {
      await db
        .insertInto('user')
        .values({
          id: u.id,
          name: u.name,
          email: u.email,
          emailVerified: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
  });

  let originalOpenAIProvider: AIProvider;

  beforeEach(() => {
    // Save the real openai provider and replace with one that skips real API calls
    originalOpenAIProvider = getProvider('openai');
  });

  afterEach(() => {
    restoreAuth?.();
    restoreAuth = null;
    mock.restore();
    // Restore the real openai provider
    registerProvider(originalOpenAIProvider);
  });

  it('POST /settings/connectors with provider openai and no baseUrl returns 201', async () => {
    // Replace the openai provider's validateApiKey to avoid real API calls
    registerProvider({
      ...originalOpenAIProvider,
      async validateApiKey() {},
    });

    const { app, restore } = createAuthenticatedApiTestApp(
      OPENAI_CONNECTOR_USER,
      settingsRoutes
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'my-openai-key',
          apiKey: 'sk-test-openai-key-1234',
          source: 'config-file',
          provider: 'openai',
        }),
      })
    );

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
    expect(payload.provider).toBe('openai');
    expect(payload.baseUrl).toBeNull();
    expect(payload.configured).toBe(true);
  });

  it('POST /settings/connectors with provider openai-compatible and no baseUrl returns 400', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      OPENAI_CONNECTOR_USER,
      settingsRoutes
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'compat-no-url',
          apiKey: 'sk-compat-test-key-5678',
          source: 'config-file',
          provider: 'openai-compatible',
        }),
      })
    );

    expect(response.status).toBe(400);

    const payload = await response.json();
    expect(payload.error).toContain('baseUrl');
  });

  it('POST /settings/connectors with provider openai-compatible and valid baseUrl returns 201', async () => {
    const COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';

    // Mock validateBaseUrl to avoid DNS lookups in test
    mock.module('../../../src/services/providers/base-url-policy', () => ({
      validateBaseUrl: async () => {},
      UnsafeBaseUrlError: class UnsafeBaseUrlError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'UnsafeBaseUrlError';
        }
      },
    }));

    // Mock fetch for the /models validation call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${COMPAT_BASE_URL}/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    try {
      const { app, restore } = createAuthenticatedApiTestApp(
        OPENAI_CONNECTOR_USER,
        settingsRoutes
      );
      restoreAuth = restore;

      const response = await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openrouter-key',
            apiKey: 'sk-or-test-key-9999',
            source: 'config-file',
            provider: 'openai-compatible',
            baseUrl: COMPAT_BASE_URL,
          }),
        })
      );

      expect(response.status).toBe(200);

      const payload = await response.json();
      expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
      expect(payload.provider).toBe('openai-compatible');
      expect(payload.baseUrl).toBe(COMPAT_BASE_URL);
      expect(payload.configured).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /settings/connectors returns openai connector with baseUrl null', async () => {
    // Replace the openai provider's validateApiKey to avoid real API calls
    registerProvider({
      ...originalOpenAIProvider,
      async validateApiKey() {},
    });

    const { app, restore } = createAuthenticatedApiTestApp(
      OPENAI_LIST_USER,
      settingsRoutes
    );
    restoreAuth = restore;

    // Create connector
    await app.handle(
      new Request('http://localhost/settings/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'openai-for-list',
          apiKey: 'sk-list-test-key-aaaa',
          source: 'config-file',
          provider: 'openai',
        }),
      })
    );

    // List connectors
    const listResponse = await app.handle(
      new Request('http://localhost/settings/connectors')
    );

    expect(listResponse.status).toBe(200);

    const listPayload = await listResponse.json();
    expect(Value.Check(ConnectorStatusSchema, listPayload)).toBe(true);

    const openaiConnector = listPayload.connectors.find(
      (c: any) => c.provider === 'openai' && c.name === 'openai-for-list'
    );

    expect(openaiConnector).toBeDefined();
    expect(openaiConnector.baseUrl).toBeNull();
  });

  it('GET /settings/connectors returns openai-compatible connector with correct baseUrl', async () => {
    const COMPAT_BASE_URL = 'https://api.deepseek.com/v1';

    // Mock validateBaseUrl
    mock.module('../../../src/services/providers/base-url-policy', () => ({
      validateBaseUrl: async () => {},
      UnsafeBaseUrlError: class UnsafeBaseUrlError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'UnsafeBaseUrlError';
        }
      },
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${COMPAT_BASE_URL}/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    try {
      const { app, restore } = createAuthenticatedApiTestApp(
        COMPAT_LIST_USER,
        settingsRoutes
      );
      restoreAuth = restore;

      // Create connector
      await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'deepseek-for-list',
            apiKey: 'sk-ds-list-test-key-bbbb',
            source: 'config-file',
            provider: 'openai-compatible',
            baseUrl: COMPAT_BASE_URL,
          }),
        })
      );

      // List connectors
      const listResponse = await app.handle(
        new Request('http://localhost/settings/connectors')
      );

      expect(listResponse.status).toBe(200);

      const listPayload = await listResponse.json();
      expect(Value.Check(ConnectorStatusSchema, listPayload)).toBe(true);

      const compatConnector = listPayload.connectors.find(
        (c: any) => c.provider === 'openai-compatible' && c.name === 'deepseek-for-list'
      );

      expect(compatConnector).toBeDefined();
      expect(compatConnector.baseUrl).toBe(COMPAT_BASE_URL);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
