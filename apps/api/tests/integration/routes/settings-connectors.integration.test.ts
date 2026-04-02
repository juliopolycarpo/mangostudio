import { describe, expect, it, afterEach, beforeAll, beforeEach, mock } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';
import { upsertSecretMetadata } from '../../../src/services/secret-store/metadata';
import { getProvider, registerProvider } from '../../../src/services/providers/registry';
import type { AIProvider } from '../../../src/services/providers/types';
import {
  OpenAIAuthError,
  OpenAIConfigError,
} from '../../../src/services/providers/openai-provider';

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

    const payload = (await response.json()) as any;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(
      payload.connectors.filter((connector: { userId: string | null }) => connector.userId === TEST_USER.id)
    ).toEqual([]);
  });

  it('GET /settings/models returns resolved catalog for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/models'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as any;
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

    const payload = (await response.json()) as any;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(payload).toMatchObject({ connectors: [] });
  });

  it('GET /settings/connectors hides shared openai-compatible config-file connectors without baseUrl', async () => {
    await upsertSecretMetadata({
      id: 'shared-compat-without-base-url',
      name: 'shared-compat-without-base-url',
      provider: 'openai-compatible',
      configured: true,
      source: 'config-file',
      maskedSuffix: '****...9999',
      updatedAt: Date.now(),
      enabledModels: [],
      userId: null,
      baseUrl: null,
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/connectors'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as any;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(
      payload.connectors.some((connector: { id: string }) => connector.id === 'shared-compat-without-base-url')
    ).toBe(false);
  });

  it('GET /settings/connectors does not return placeholder config-file connectors from local dev config', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/connectors'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as any;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);

    const connectorNames = payload.connectors.map((connector: { name: string }) => connector.name);
    expect(connectorNames).not.toContain('openai-for-list');
    expect(connectorNames).not.toContain('deepseek-for-list');
    expect(connectorNames).not.toContain('openai-proj-model-update');
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

/** Dedicated user for project/org scoped OpenAI tests. */
const OPENAI_PROJ_USER = {
  id: 'test-user-openai-proj',
  name: 'OpenAI Proj User',
  email: 'test-openai-proj@mangostudio.test',
};

/** Dedicated user for OpenAI auth-failure path tests. */
const OPENAI_FAIL_USER = {
  id: 'test-user-openai-fail',
  name: 'OpenAI Fail User',
  email: 'test-openai-fail@mangostudio.test',
};

const ConnectorResponseSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  provider: Type.String(),
  configured: Type.Boolean(),
  source: Type.String(),
  baseUrl: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Returns a fetch mock that intercepts any URL containing '/models' and
 * responds with a minimal OpenAI-compatible model list (HTTP 200).
 * All other requests are forwarded to the real fetch.
 */
function makeOpenAISuccessFetch(originalFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.openai.com') && url.includes('/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

describe('openai connector routes', () => {
  beforeAll(async () => {
    const db = getDb();
    const now = Date.now();
    for (const u of [
      OPENAI_CONNECTOR_USER,
      OPENAI_LIST_USER,
      COMPAT_LIST_USER,
      OPENAI_PROJ_USER,
      OPENAI_FAIL_USER,
    ]) {
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
    // Save the real openai provider for restoration
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
    // The route calls validateOpenAIAuthContext which uses the OpenAI SDK internally.
    // Mock global fetch so the SDK model listing call returns 200.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeOpenAISuccessFetch(originalFetch);

    try {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_CONNECTOR_USER, settingsRoutes);
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

      const payload = (await response.json()) as any;
      expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
      expect(payload.provider).toBe('openai');
      expect(payload.baseUrl).toBeNull();
      expect(payload.configured).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('POST /settings/connectors with provider openai-compatible and no baseUrl returns 400', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(OPENAI_CONNECTOR_USER, settingsRoutes);
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

    const payload = (await response.json()) as any;
    expect(payload.error).toContain('baseUrl');
  });

  it('POST /settings/connectors with provider openai-compatible and valid baseUrl returns 201', async () => {
    const COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';

    // Mock validateBaseUrl to avoid DNS lookups in test
    await mock.module('../../../src/services/providers/base-url-policy', () => ({
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
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${COMPAT_BASE_URL}/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    try {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_CONNECTOR_USER, settingsRoutes);
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

      const payload = (await response.json()) as any;
      expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
      expect(payload.provider).toBe('openai-compatible');
      expect(payload.baseUrl).toBe(COMPAT_BASE_URL);
      expect(payload.configured).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /settings/connectors returns openai connector with baseUrl null', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeOpenAISuccessFetch(originalFetch);

    try {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_LIST_USER, settingsRoutes);
      restoreAuth = restore;

      // Create connector
      await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openai-for-list',
            apiKey: 'sk-live-openai-list-aaaa',
            source: 'config-file',
            provider: 'openai',
          }),
        })
      );

      // List connectors
      const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));

      expect(listResponse.status).toBe(200);

      const listPayload = (await listResponse.json()) as any;
      expect(Value.Check(ConnectorStatusSchema, listPayload)).toBe(true);

      const openaiConnector = listPayload.connectors.find(
        (c: any) => c.provider === 'openai' && c.name === 'openai-for-list'
      );

      expect(openaiConnector).toBeDefined();
      expect(openaiConnector.baseUrl).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /settings/connectors returns openai-compatible connector with correct baseUrl', async () => {
    const COMPAT_BASE_URL = 'https://api.deepseek.com/v1';

    // Mock validateBaseUrl
    await mock.module('../../../src/services/providers/base-url-policy', () => ({
      validateBaseUrl: async () => {},
      UnsafeBaseUrlError: class UnsafeBaseUrlError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'UnsafeBaseUrlError';
        }
      },
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${COMPAT_BASE_URL}/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    try {
      const { app, restore } = createAuthenticatedApiTestApp(COMPAT_LIST_USER, settingsRoutes);
      restoreAuth = restore;

      // Create connector
      await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'deepseek-for-list',
            apiKey: 'sk-live-compat-list-bbbb',
            source: 'config-file',
            provider: 'openai-compatible',
            baseUrl: COMPAT_BASE_URL,
          }),
        })
      );

      // List connectors
      const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));

      expect(listResponse.status).toBe(200);

      const listPayload = (await listResponse.json()) as any;
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

  it('PUT /settings/connectors/:id/models updates a shared OpenAI connector loaded from config-file', async () => {
    const connectorId = 'shared-openai-config-connector';

    await upsertSecretMetadata({
      id: connectorId,
      name: 'shared-openai-config',
      provider: 'openai',
      configured: true,
      source: 'config-file',
      maskedSuffix: '****...1234',
      updatedAt: Date.now(),
      enabledModels: [],
      userId: null,
      organizationId: null,
      projectId: null,
    });

    const { app, restore } = createAuthenticatedApiTestApp(OPENAI_LIST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/settings/connectors/${connectorId}/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: ['gpt-4o'] }),
      })
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as any;
    expect(payload).toEqual({ success: true });

    const db = getDb();
    const row = await db
      .selectFrom('secret_metadata')
      .selectAll()
      .where('id', '=', connectorId)
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(row!.userId).toBeNull();
    expect(row!.enabledModels).toBe(JSON.stringify(['gpt-4o']));
  });
});

/* ------------------------------------------------------------------ */
/*  OpenAI project/org-scoped auth context integration tests           */
/* ------------------------------------------------------------------ */

describe('openai project-scoped connector routes', () => {
  let originalOpenAIProvider: AIProvider;

  beforeEach(() => {
    originalOpenAIProvider = getProvider('openai');
  });

  afterEach(() => {
    restoreAuth?.();
    restoreAuth = null;
    mock.restore();
    registerProvider(originalOpenAIProvider);
  });

  it('POST /settings/connectors stores organizationId and projectId nullably', async () => {
    // The route calls validateOpenAIAuthContext directly via the SDK.
    // Mock fetch to return a 200 so validation passes without real API calls.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeOpenAISuccessFetch(originalFetch);

    try {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_PROJ_USER, settingsRoutes);
      restoreAuth = restore;

      const response = await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openai-proj-key',
            apiKey: 'sk-proj-test-key-aaaa',
            source: 'config-file',
            provider: 'openai',
            organizationId: 'org-testorg999',
            projectId: 'proj_testproj888',
          }),
        })
      );

      expect(response.status).toBe(200);

      const payload = (await response.json()) as any;
      expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
      expect(payload.provider).toBe('openai');
      expect(payload.configured).toBe(true);
      expect(payload.baseUrl).toBeNull();

      // Verify the org/project fields were persisted in the DB
      const db = getDb();
      const row = await db
        .selectFrom('secret_metadata')
        .selectAll()
        .where('id', '=', payload.id)
        .executeTakeFirst();

      expect(row).toBeDefined();
      expect(row!.organizationId).toBe('org-testorg999');
      expect(row!.projectId).toBe('proj_testproj888');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('POST /settings/connectors with omitted org/project stores null', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeOpenAISuccessFetch(originalFetch);

    try {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_PROJ_USER, settingsRoutes);
      restoreAuth = restore;

      const response = await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openai-key-no-org',
            apiKey: 'sk-no-org-test-key-bbbb',
            source: 'config-file',
            provider: 'openai',
          }),
        })
      );

      expect(response.status).toBe(200);

      const payload = (await response.json()) as any;
      const db = getDb();
      const row = await db
        .selectFrom('secret_metadata')
        .selectAll()
        .where('id', '=', payload.id)
        .executeTakeFirst();

      expect(row).toBeDefined();
      expect(row!.organizationId).toBeNull();
      expect(row!.projectId).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('PUT /settings/connectors/:id/models preserves organizationId and projectId for OpenAI connectors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeOpenAISuccessFetch(originalFetch);

    try {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_PROJ_USER, settingsRoutes);
      restoreAuth = restore;

      const createResponse = await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openai-proj-model-update',
            apiKey: 'sk-proj-model-update-key',
            source: 'config-file',
            provider: 'openai',
            organizationId: 'org-testorg999',
            projectId: 'proj_testproj888',
          }),
        })
      );

      expect(createResponse.status).toBe(200);

      const created = (await createResponse.json()) as any;

      const updateResponse = await app.handle(
        new Request(`http://localhost/settings/connectors/${created.id}/models`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabledModels: ['gpt-4o'] }),
        })
      );

      expect(updateResponse.status).toBe(200);

      const db = getDb();
      const row = await db
        .selectFrom('secret_metadata')
        .selectAll()
        .where('id', '=', created.id)
        .executeTakeFirst();

      expect(row).toBeDefined();
      expect(row!.organizationId).toBe('org-testorg999');
      expect(row!.projectId).toBe('proj_testproj888');
      expect(row!.enabledModels).toBe(JSON.stringify(['gpt-4o']));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('POST /settings/connectors returns 401 when OpenAI rejects credentials', async () => {
    // Stub validateOpenAIAuthContext at the module level so the route sees it.
    await mock.module('../../../src/services/providers/openai-provider', () => ({
      validateOpenAIAuthContext: async () => {
        throw new OpenAIAuthError(
          'OpenAI API key is invalid or expired. Verify your key and try again.',
          401
        );
      },
      OpenAIAuthError,
      OpenAIConfigError,
    }));

    const { app, restore } = createAuthenticatedApiTestApp(OPENAI_FAIL_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'bad-openai-key',
          apiKey: 'sk-bad-key-cccc',
          source: 'config-file',
          provider: 'openai',
        }),
      })
    );

    expect(response.status).toBe(401);

    const payload = (await response.json()) as any;
    expect(payload.error).toContain('invalid or expired');
  });

  it('POST /settings/connectors returns 403 when OpenAI denies org/project access', async () => {
    await mock.module('../../../src/services/providers/openai-provider', () => ({
      validateOpenAIAuthContext: async () => {
        throw new OpenAIAuthError(
          'OpenAI access denied. Check that your organization ID, project ID, and key permissions are correct.',
          403
        );
      },
      OpenAIAuthError,
      OpenAIConfigError,
    }));

    const { app, restore } = createAuthenticatedApiTestApp(OPENAI_FAIL_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'forbidden-openai-key',
          apiKey: 'sk-forbidden-key-dddd',
          source: 'config-file',
          provider: 'openai',
          organizationId: 'org-wrongorg',
        }),
      })
    );

    expect(response.status).toBe(403);

    const payload = (await response.json()) as any;
    expect(payload.error).toContain('organization ID');
  });
});
