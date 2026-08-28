import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { ModelCatalogResponseSchema } from '@mangostudio/shared/catalog';
import { ConnectorStatusSchema } from '@mangostudio/shared/connectors';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { TEST_MANAGED_CONFIG_PATH } from '../../../src/lib/config';
import { ConnectorNotFoundError } from '../../../src/modules/connectors/application/connector-errors';
import { settingsRoutes } from '../../../src/routes/settings';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import { OpenAIAuthError, OpenAIConfigError } from '../../../src/services/providers/openai/index';
import type { AIProvider } from '../../../src/services/providers/types';
import { upsertSecretMetadata } from '../../../src/services/secret-store/metadata';
import {
  allowAnyBaseUrl,
  type ConnectorListPayload,
  type ConnectorPayload,
  ConnectorResponseSchema,
  type ErrorPayload,
  type ModelCatalogPayload,
  makeModelsEndpointFetch,
  makeOpenAISuccessFetch,
  restoreConnectorProviderMocks,
  type SuccessPayload,
  withFetch,
} from '../../support/connectors';
import { ensureTestUsers, insertTestConnector, makeTestIdentity } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'test-user-connectors',
  name: 'Test User',
  email: 'test-connectors@mangostudio.test',
};

/**
 * Two `[openai_api_keys]` entries the placeholder test writes into the managed
 * config file: one whose value `isPlaceholderConfigSecretValue` rejects, one it
 * accepts. The accepted one is what keeps the rejection assertion honest.
 */
const PLACEHOLDER_CONNECTOR_NAME = 'openai-placeholder-from-dev-config';
const REAL_CONFIG_CONNECTOR_NAME = 'openai-real-from-dev-config';

const CURSOR_CONNECTOR_USER = {
  id: 'test-user-cursor-connectors',
  name: 'Cursor Test User',
  email: 'test-cursor-connectors@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

/*
 * Every `describe` seeds — with `ensureTestUsers`, from tests/support/factories
 * — the identities *it* authenticates as, and no others. Sharing a seed across
 * blocks makes the file order-dependent: `beforeAll` runs per `describe`, so a
 * block that reads a row a sibling block inserted only passes while the runner
 * happens to schedule them in that order. It did not under `--randomize` — see
 * the block comment on the project-scoped block.
 */

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  // Re-register the real openai/base-url/gemini/@google/genai modules so
  // mock.module overrides do not leak into later test files (mock.restore()
  // does not revert mock.module()).
  await restoreConnectorProviderMocks();
});

describe('settings connectors routes', () => {
  beforeAll(() => ensureTestUsers(TEST_USER));

  it('GET /settings/connectors returns empty connector list for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/connectors'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as ConnectorListPayload;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(payload.connectors.filter((connector) => connector.userId === TEST_USER.id)).toEqual([]);
  });

  it('GET /settings/models returns resolved catalog for a new user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/models'));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as ModelCatalogPayload;
    expect(Value.Check(ModelCatalogResponseSchema, payload)).toBe(true);
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

    const payload = (await response.json()) as ConnectorListPayload;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(payload.connectors.filter((connector) => connector.userId === TEST_USER.id)).toEqual([]);
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

    const payload = (await response.json()) as ConnectorListPayload;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    expect(
      payload.connectors.some((connector) => connector.id === 'shared-compat-without-base-url')
    ).toBe(false);
  });

  it('GET /settings/connectors does not return placeholder config-file connectors from local dev config', async () => {
    // The dev config this asserts on is written here, by name and by value.
    // It used to assert the absence of three names that *sibling* `describe`
    // blocks create — which the managed config file is wiped between tests to
    // prevent, so those names could never appear and all three assertions
    // passed against nothing, in every order.
    writeFileSync(
      TEST_MANAGED_CONFIG_PATH,
      [
        '[openai_api_keys]',
        `${PLACEHOLDER_CONNECTOR_NAME} = "your-secret-key-here"`,
        `${REAL_CONFIG_CONNECTOR_NAME} = "sk-live-openai-config-aaaa"`,
        '',
      ].join('\n')
    );

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    try {
      const response = await app.handle(new Request('http://localhost/settings/connectors'));

      expect(response.status).toBe(200);

      const payload = (await response.json()) as ConnectorListPayload;
      expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);

      const connectorNames = payload.connectors.map((connector) => connector.name);
      expect(connectorNames).not.toContain(PLACEHOLDER_CONNECTOR_NAME);
      // The tripwire. Absence is only evidence while the sync that would have
      // surfaced the entry actually ran; a real key from the same file proves
      // it did, so this test can never pass on an empty list again.
      expect(connectorNames).toContain(REAL_CONFIG_CONNECTOR_NAME);
    } finally {
      // Config-file sync stores its rows as shared ones (`userId` null) and
      // nothing truncates the table between tests, so the real entry would
      // otherwise stay visible to every file that runs later in the lane.
      await getDb()
        .deleteFrom('secret_metadata')
        .where('name', 'in', [PLACEHOLDER_CONNECTOR_NAME, REAL_CONFIG_CONNECTOR_NAME])
        .execute();
    }
  });

  it('GET /settings/connectors omits a connector owned by another user', async () => {
    // The scoping half of the list contract, which nothing else pins: the
    // empty-list test above filters by `userId` before asserting, so it cannot
    // notice a regression that starts handing out other people's rows.
    const otherUser = makeTestIdentity('connector-scope-other', 'Connector Scope Other');
    await ensureTestUsers(otherUser);
    const foreignConnector = await insertTestConnector(otherUser.id, {
      name: 'connector-owned-by-another-user',
      provider: 'openai',
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    try {
      const response = await app.handle(new Request('http://localhost/settings/connectors'));

      expect(response.status).toBe(200);

      const payload = (await response.json()) as ConnectorListPayload;
      expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
      expect(payload.connectors.some((connector) => connector.id === foreignConnector.id)).toBe(
        false
      );
    } finally {
      await getDb().deleteFrom('secret_metadata').where('id', '=', foreignConnector.id).execute();
    }
  });
});

/**
 * Cursor is a deprecated provider. These pin the two halves of that: new setup
 * is refused by the endpoint rather than only hidden by the picker, and nothing
 * a user already has is taken away.
 */
describe('deprecated cursor connector routes', () => {
  beforeAll(() => ensureTestUsers(CURSOR_CONNECTOR_USER));

  afterEach(() => {
    restoreAuth?.();
    restoreAuth = null;
  });

  it('refuses to create a cursor connector through the API', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(CURSOR_CONNECTOR_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'cursor-for-create',
          apiKey: 'cursor-live-create-key',
          source: 'config-file',
          provider: 'cursor',
        }),
      })
    );

    expect(response.status).toBe(410);

    const payload = (await response.json()) as ErrorPayload;
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload.code).toBe(ERROR_CODES.UNSUPPORTED);
    expect(payload.error).toContain('cursor');
    expect(payload.error).toContain('no longer run turns');
    expect(payload.error).not.toContain('keep working');
  });

  it('keeps an existing cursor connector visible with its stored secret', async () => {
    // Written straight to metadata: the endpoint that used to create these is
    // now closed, and the connector this deprecation must not disturb is one
    // that predates it.
    await upsertSecretMetadata({
      id: 'legacy-cursor-connector',
      name: 'legacy-cursor',
      provider: 'cursor',
      configured: true,
      source: 'config-file',
      maskedSuffix: '...key',
      updatedAt: Date.now(),
      lastValidatedAt: Date.now(),
      enabledModels: ['composer-2.5'],
      userId: CURSOR_CONNECTOR_USER.id,
      baseUrl: null,
    });

    const { app, restore } = createAuthenticatedApiTestApp(CURSOR_CONNECTOR_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/settings/connectors'));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as ConnectorListPayload;
    expect(Value.Check(ConnectorStatusSchema, payload)).toBe(true);
    const legacy = payload.connectors.find((connector) => connector.name === 'legacy-cursor');
    expect(legacy?.provider).toBe('cursor');
    expect(legacy?.configured).toBe(true);
    expect(legacy?.enabledModels).toEqual(['composer-2.5']);
  });

  it('keeps that connector’s models out of the catalog', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(CURSOR_CONNECTOR_USER, settingsRoutes);
    restoreAuth = restore;

    const catalogResponse = await app.handle(new Request('http://localhost/settings/models'));
    expect(catalogResponse.status).toBe(200);

    const catalog = (await catalogResponse.json()) as ModelCatalogPayload;
    for (const model of catalog.allModels) {
      expect(model.provider).not.toBe('cursor');
    }
    expect(catalog.textModels).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Gemini aliases routes integration tests                           */
/* ------------------------------------------------------------------ */

describe('Gemini aliases API', () => {
  beforeAll(() => ensureTestUsers(TEST_USER));

  // Per test, not once per block: the file-level `afterEach` restores the real
  // `@google/genai` after every test (`mock.restore()` does not revert
  // `mock.module()`, so that restore is the only thing that keeps this fake
  // from following the process into the next file), which would leave a
  // `beforeAll` fake installed for the first test only.
  beforeEach(async () => {
    await mock.module('@google/genai', () => {
      return {
        GoogleGenAI: class {
          models = {
            list: () =>
              Promise.resolve({
                getPage: () =>
                  Promise.resolve([
                    {
                      name: 'models/gemini-2.0-flash',
                      displayName: 'Gemini 2.0 Flash',
                      supportedActions: ['generateContent'],
                    },
                  ]),
              }),
          };
        },
      };
    });
  });

  it('POST /settings/connectors/gemini adds a connector', async () => {
    // We mock the gemini module to bypass actual validation which uses real fetch
    await mock.module('../../../src/services/gemini', () => {
      return {
        getGeminiSecretStatus: () => Promise.resolve({ connectors: [] }),
        addGeminiConnector: () =>
          Promise.resolve({
            id: 'mock-gemini-id',
            name: 'Alias Connector',
            provider: 'gemini',
            configured: true,
            source: 'database',
            userId: TEST_USER.id,
          }),
        deleteGeminiConnector: () => Promise.resolve(),
        updateConnectorModels: () => Promise.resolve(),
        refreshGeminiModelCatalog: () => Promise.resolve(),
      };
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alias Connector',
          provider: 'gemini',
          apiKey: 'fake-alias-key',
          source: 'bun-secrets',
        }),
      })
    );

    expect(response.status).toBe(200);
    const connector = await response.json();
    expect(connector).toHaveProperty('id');
    expect(connector).toMatchObject({
      name: 'Alias Connector',
      provider: 'gemini',
    });
  });

  it('PUT /settings/connectors/gemini/:id/models updates models', async () => {
    await mock.module('../../../src/services/gemini', () => {
      return {
        updateConnectorModels: () => Promise.resolve(),
      };
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/settings/connectors/gemini/mock-gemini-id/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabledModels: ['gemini-2.0-flash'],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });

  it('PUT /settings/connectors/gemini/:id/models returns 404 for a missing connector', async () => {
    await mock.module('../../../src/services/gemini', () => {
      return {
        updateConnectorModels: () => Promise.reject(new ConnectorNotFoundError()),
      };
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors/gemini/missing-gemini-id/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: ['gemini-2.0-flash'] }),
      })
    );

    expect(response.status).toBe(404);

    const payload = (await response.json()) as ErrorPayload;
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload).toEqual({ error: 'Connector not found.', code: ERROR_CODES.NOT_FOUND });
  });

  it('DELETE /settings/connectors/gemini/:id removes a connector', async () => {
    await mock.module('../../../src/services/gemini', () => {
      return {
        deleteGeminiConnector: () => Promise.resolve(),
        refreshGeminiModelCatalog: () => Promise.resolve(),
      };
    });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/settings/connectors/gemini/mock-gemini-id`, {
        method: 'DELETE',
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });
});

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

const DEEPSEEK_CONNECTOR_USER = {
  id: 'test-user-deepseek-connectors',
  name: 'DeepSeek Test User',
  email: 'test-deepseek-connectors@mangostudio.test',
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

describe('openai connector routes', () => {
  // This block's own identities only. `OPENAI_PROJ_USER` and
  // `OPENAI_FAIL_USER` used to be seeded here and consumed by the
  // project-scoped block below, which is exactly the dependency that broke.
  beforeAll(() =>
    ensureTestUsers(
      OPENAI_CONNECTOR_USER,
      OPENAI_LIST_USER,
      COMPAT_LIST_USER,
      DEEPSEEK_CONNECTOR_USER
    )
  );

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
    await withFetch(makeOpenAISuccessFetch(globalThis.fetch), async () => {
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

      const payload = (await response.json()) as ConnectorPayload;
      expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
      expect(payload.provider).toBe('openai');
      expect(payload.baseUrl).toBeNull();
      expect(payload.configured).toBe(true);
    });
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

    const payload = (await response.json()) as ErrorPayload;
    expect(payload.error).toContain('baseUrl');
  });

  it('POST /settings/connectors with provider openai-compatible and valid baseUrl returns 201', async () => {
    const COMPAT_BASE_URL = 'https://openrouter.ai/api/v1';

    await allowAnyBaseUrl();
    await withFetch(
      makeModelsEndpointFetch(globalThis.fetch, `${COMPAT_BASE_URL}/models`),
      async () => {
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

        const payload = (await response.json()) as ConnectorPayload;
        expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
        expect(payload.provider).toBe('openai-compatible');
        expect(payload.baseUrl).toBe(COMPAT_BASE_URL);
        expect(payload.configured).toBe(true);
      }
    );
  });

  it('POST /settings/connectors with provider deepseek stores default baseUrl metadata', async () => {
    const realFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/useAwait: matches the fetch signature
    const deepseekModelsFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.deepseek.com/models') {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-deepseek-test-key' });
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;

    await withFetch(deepseekModelsFetch, async () => {
      const { app, restore } = createAuthenticatedApiTestApp(
        DEEPSEEK_CONNECTOR_USER,
        settingsRoutes
      );
      restoreAuth = restore;

      const response = await app.handle(
        new Request('http://localhost/settings/connectors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'deepseek-key',
            apiKey: 'sk-deepseek-test-key',
            source: 'config-file',
            provider: 'deepseek',
          }),
        })
      );

      expect(response.status).toBe(200);

      const payload = (await response.json()) as ConnectorPayload;
      expect(Value.Check(ConnectorResponseSchema, payload)).toBe(true);
      expect(payload.provider).toBe('deepseek');
      expect(payload.baseUrl).toBeNull();
      expect(payload.configured).toBe(true);
    });
  });

  it('GET /settings/connectors returns openai connector with baseUrl null', async () => {
    await withFetch(makeOpenAISuccessFetch(globalThis.fetch), async () => {
      const { app, restore } = createAuthenticatedApiTestApp(OPENAI_LIST_USER, settingsRoutes);
      restoreAuth = restore;

      // Create connector
      const createResponse = await app.handle(
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
      expect(createResponse.status).toBe(200);

      // List connectors
      const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));

      expect(listResponse.status).toBe(200);

      const listPayload = (await listResponse.json()) as ConnectorListPayload;
      expect(Value.Check(ConnectorStatusSchema, listPayload)).toBe(true);

      const openaiConnector = listPayload.connectors.find(
        (c) => c.provider === 'openai' && c.name === 'openai-for-list'
      );

      expect(openaiConnector).toBeDefined();
      expect(openaiConnector?.baseUrl).toBeNull();
    });
  });

  it('GET /settings/connectors returns openai-compatible connector with correct baseUrl', async () => {
    const COMPAT_BASE_URL = 'https://api.deepseek.com/v1';

    await allowAnyBaseUrl();
    await withFetch(
      makeModelsEndpointFetch(globalThis.fetch, `${COMPAT_BASE_URL}/models`),
      async () => {
        const { app, restore } = createAuthenticatedApiTestApp(COMPAT_LIST_USER, settingsRoutes);
        restoreAuth = restore;

        // Create connector
        const createResponse = await app.handle(
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
        expect(createResponse.status).toBe(200);

        // List connectors
        const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));

        expect(listResponse.status).toBe(200);

        const listPayload = (await listResponse.json()) as ConnectorListPayload;
        expect(Value.Check(ConnectorStatusSchema, listPayload)).toBe(true);

        const compatConnector = listPayload.connectors.find(
          (c) => c.provider === 'openai-compatible' && c.name === 'deepseek-for-list'
        );

        expect(compatConnector).toBeDefined();
        expect(compatConnector?.baseUrl).toBe(COMPAT_BASE_URL);
      }
    );
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

    const payload = (await response.json()) as SuccessPayload;
    expect(payload).toEqual({ success: true });

    const db = getDb();
    const row = await db
      .selectFrom('secret_metadata')
      .selectAll()
      .where('id', '=', connectorId)
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(row?.userId).toBeNull();
    expect(row?.enabledModels).toBe(JSON.stringify(['gpt-4o']));
  });

  it('PUT /settings/connectors/:id/models returns 404 for a missing connector', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(OPENAI_LIST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors/missing-openai-id/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: ['gpt-4o'] }),
      })
    );

    expect(response.status).toBe(404);

    const payload = (await response.json()) as ErrorPayload;
    expect(Value.Check(ApiErrorResponseSchema, payload)).toBe(true);
    expect(payload).toEqual({ error: 'Connector not found.', code: ERROR_CODES.NOT_FOUND });
  });
});

/* ------------------------------------------------------------------ */
/*  OpenAI project/org-scoped auth context integration tests           */
/* ------------------------------------------------------------------ */

describe('openai project-scoped connector routes', () => {
  // Both identities used to be seeded by the `openai connector routes` block
  // above, which never authenticates as either. `beforeAll` runs per
  // `describe`, so this block only passed while the runner happened to schedule
  // the other one first — under `--randomize` it does not, and every route here
  // that persists a connector failed the `secret_metadata` foreign key and
  // answered 500. Seeding what this block actually uses removes the ordering
  // assumption rather than pinning an order.
  beforeAll(() => ensureTestUsers(OPENAI_PROJ_USER, OPENAI_FAIL_USER));

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
    await withFetch(makeOpenAISuccessFetch(globalThis.fetch), async () => {
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

      const payload = (await response.json()) as ConnectorPayload;
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
      expect(row?.organizationId).toBe('org-testorg999');
      expect(row?.projectId).toBe('proj_testproj888');
    });
  });

  it('POST /settings/connectors with omitted org/project stores null', async () => {
    await withFetch(makeOpenAISuccessFetch(globalThis.fetch), async () => {
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

      const payload = (await response.json()) as ConnectorPayload;
      const db = getDb();
      const row = await db
        .selectFrom('secret_metadata')
        .selectAll()
        .where('id', '=', payload.id)
        .executeTakeFirst();

      expect(row).toBeDefined();
      expect(row?.organizationId).toBeNull();
      expect(row?.projectId).toBeNull();
    });
  });

  it('PUT /settings/connectors/:id/models preserves organizationId and projectId for OpenAI connectors', async () => {
    await withFetch(makeOpenAISuccessFetch(globalThis.fetch), async () => {
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

      const created = (await createResponse.json()) as ConnectorPayload;

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
      expect(row?.organizationId).toBe('org-testorg999');
      expect(row?.projectId).toBe('proj_testproj888');
      expect(row?.enabledModels).toBe(JSON.stringify(['gpt-4o']));
    });
  });

  it('POST /settings/connectors returns 401 when OpenAI rejects credentials', async () => {
    // Stub validateOpenAIAuthContext at the module level so the route sees it.
    await mock.module('../../../src/services/providers/openai/index', () => ({
      validateOpenAIAuthContext: () =>
        Promise.reject(
          new OpenAIAuthError(
            'OpenAI API key is invalid or expired. Verify your key and try again.',
            401
          )
        ),
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

    const payload = (await response.json()) as ErrorPayload;
    expect(payload.error).toContain('invalid or expired');
  });

  it('POST /settings/connectors returns 403 when OpenAI denies org/project access', async () => {
    await mock.module('../../../src/services/providers/openai/index', () => ({
      validateOpenAIAuthContext: () =>
        Promise.reject(
          new OpenAIAuthError(
            'OpenAI access denied. Check that your organization ID, project ID, and key permissions are correct.',
            403
          )
        ),
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

    const payload = (await response.json()) as ErrorPayload;
    expect(payload.error).toContain('organization ID');
  });
});
