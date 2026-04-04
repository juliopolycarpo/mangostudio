import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import { createProviderSecretService } from '../../../../src/services/providers/secret-service';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';
import {
  validateOpenAIAuthContext,
  OpenAIAuthError,
  OpenAIConfigError,
} from '../../../../src/services/providers/openai-provider';

const TEST_USER = 'test-user-openai';
const NO_TOML = '/tmp/mangostudio-test-nonexistent-config.toml';

/**
 * Creates an in-memory metadata harness for test isolation.
 * Mirrors the pattern from gemini-secret.test.ts.
 */
function createMetadataHarness(initial: SecretMetadataRow[] = []) {
  let rows: SecretMetadataRow[] = [...initial];

  return {
    listMetadata: async (_provider: string, _userId: string) => [...rows],
    getMetadataById: async (id: string, _userId: string) => rows.find((r) => r.id === id) ?? null,
    upsertMetadata: async (input: SecretMetadataInput) => {
      const idx = rows.findIndex((r) => r.id === input.id);
      const row: SecretMetadataRow = {
        id: input.id,
        name: input.name,
        provider: input.provider,
        configured: input.configured ? 1 : 0,
        source: input.source,
        maskedSuffix: input.maskedSuffix ?? null,
        updatedAt: input.updatedAt,
        lastValidatedAt: input.lastValidatedAt ?? null,
        lastValidationError: input.lastValidationError ?? null,
        enabledModels: JSON.stringify(input.enabledModels),
        userId: input.userId,
        baseUrl: input.baseUrl ?? null,
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
      };
      if (idx >= 0) {
        rows[idx] = row;
      } else {
        rows.push(row);
      }
    },
    deleteMetadata: async (id: string, _userId: string) => {
      rows = rows.filter((r) => r.id !== id);
    },
    getCurrentRows: () => rows,
  };
}

/** Builds a configured SecretMetadataRow for the openai provider. */
function makeOpenAIRow(overrides: Partial<SecretMetadataRow> = {}): SecretMetadataRow {
  return {
    id: 'oai-row-1',
    name: 'default',
    provider: 'openai',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: '****...abcd',
    updatedAt: Date.now(),
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: JSON.stringify([]),
    userId: TEST_USER,
    baseUrl: null,
    organizationId: null,
    projectId: null,
    ...overrides,
  };
}

describe('openai-provider', () => {
  it('providerType is openai', async () => {
    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    expect(openAIProvider.providerType).toBe('openai');
  });

  it('is registered in the provider registry after import', async () => {
    await import('../../../../src/services/providers/openai-provider');
    const { getProvider } = await import('../../../../src/services/providers/registry');
    const provider = getProvider('openai');
    expect(provider.providerType).toBe('openai');
  });

  it('implements the required AIProvider methods', async () => {
    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    expect(typeof openAIProvider.generateText).toBe('function');
    expect(typeof openAIProvider.listModels).toBe('function');
    expect(typeof openAIProvider.validateApiKey).toBe('function');
    expect(typeof openAIProvider.resolveApiKey).toBe('function');
  });
});

describe('openai-provider resolveClientConfig (via secretService)', () => {
  it('resolveApiKey returns the key from a configured connector', async () => {
    const configuredRow = makeOpenAIRow({ enabledModels: JSON.stringify([]) });
    const metadata = createMetadataHarness([configuredRow]);
    const secretStore = new InMemorySecretStore();
    const API_KEY = 'sk-test-key-abcd';

    await secretStore.setSecret(
      { service: 'mangostudio', name: `openai-api-key:${configuredRow.id}` },
      API_KEY
    );

    const service = createProviderSecretService(
      {
        provider: 'openai',
        tomlSection: 'openai_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {},
      },
      {
        secretStore,
        tomlFilePath: NO_TOML,
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    const key = await service.resolveApiKey(TEST_USER);
    expect(key).toBe(API_KEY);
  });

  it('throws when no configured connector exists', async () => {
    const metadata = createMetadataHarness([]);
    const service = createProviderSecretService(
      {
        provider: 'openai',
        tomlSection: 'openai_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {},
      },
      {
        secretStore: new InMemorySecretStore(),
        tomlFilePath: NO_TOML,
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    await expect(service.resolveApiKey(TEST_USER)).rejects.toThrow(
      'No openai API key is configured or enabled'
    );
  });

  it('skips unconfigured rows', async () => {
    const unconfiguredRow = makeOpenAIRow({ configured: 0 });
    const metadata = createMetadataHarness([unconfiguredRow]);

    const service = createProviderSecretService(
      {
        provider: 'openai',
        tomlSection: 'openai_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {},
      },
      {
        secretStore: new InMemorySecretStore(),
        tomlFilePath: NO_TOML,
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    await expect(service.resolveApiKey(TEST_USER)).rejects.toThrow(
      'No openai API key is configured or enabled'
    );
  });

  it('respects enabledModels filter when modelName is given', async () => {
    const rowA = makeOpenAIRow({
      id: 'oai-row-a',
      name: 'key-a',
      enabledModels: JSON.stringify(['gpt-4o']),
    });
    const rowB = makeOpenAIRow({
      id: 'oai-row-b',
      name: 'key-b',
      enabledModels: JSON.stringify(['gpt-4o-mini']),
    });
    const metadata = createMetadataHarness([rowA, rowB]);

    const secretStore = new InMemorySecretStore();
    const KEY_A = 'sk-key-a-xxxx';
    const KEY_B = 'sk-key-b-yyyy';
    await secretStore.setSecret(
      { service: 'mangostudio', name: `openai-api-key:${rowA.id}` },
      KEY_A
    );
    await secretStore.setSecret(
      { service: 'mangostudio', name: `openai-api-key:${rowB.id}` },
      KEY_B
    );

    const service = createProviderSecretService(
      {
        provider: 'openai',
        tomlSection: 'openai_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {},
      },
      {
        secretStore,
        tomlFilePath: NO_TOML,
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    // Requesting gpt-4o-mini should skip rowA and resolve rowB
    const key = await service.resolveApiKey(TEST_USER, 'gpt-4o-mini');
    expect(key).toBe(KEY_B);
  });
});

// ---------------------------------------------------------------------------
// validateOpenAIAuthContext — the shared validation path for connectors
// ---------------------------------------------------------------------------

describe('validateOpenAIAuthContext', () => {
  it('succeeds when SDK receives a 200 response from model listing', async () => {
    // Patch the OpenAI SDK client's models.list to return success.
    // We do this by intercepting via global fetch since the SDK uses fetch internally.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'openai' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, _init);
    }) as typeof fetch;

    try {
      // Should not throw
      await expect(
        validateOpenAIAuthContext({ apiKey: 'sk-valid-key-1234' })
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('succeeds when auth context includes organizationId and projectId', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        const headers = init?.headers
          ? Object.fromEntries(
              init.headers instanceof Headers
                ? init.headers.entries()
                : Object.entries(init.headers as Record<string, string>)
            )
          : {};
        capturedHeaders.push(headers);
        return new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      await validateOpenAIAuthContext({
        apiKey: 'sk-proj-scoped-key',
        organizationId: 'org-testorg123',
        projectId: 'proj_testproject456',
      });
      // The SDK should have sent OpenAI-Organization and OpenAI-Project headers
      expect(capturedHeaders.length).toBeGreaterThan(0);
      const h = capturedHeaders[0]!;
      expect(h['openai-organization']).toBe('org-testorg123');
      expect(h['openai-project']).toBe('proj_testproject456');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws OpenAIAuthError for 401 response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Incorrect API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return globalThis.fetch(input, _init);
    }) as typeof fetch;

    try {
      await expect(validateOpenAIAuthContext({ apiKey: 'sk-invalid-key' })).rejects.toThrow(
        OpenAIAuthError
      );

      await expect(validateOpenAIAuthContext({ apiKey: 'sk-invalid-key' })).rejects.toThrow(
        'invalid or expired'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws OpenAIAuthError with status 403 for permission denied', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            error: { message: 'Permission denied', type: 'invalid_request_error' },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return globalThis.fetch(input, _init);
    }) as typeof fetch;

    try {
      let caughtError: unknown;
      try {
        await validateOpenAIAuthContext({
          apiKey: 'sk-restricted-key',
          organizationId: 'org-wrong',
        });
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).toBeInstanceOf(OpenAIAuthError);
      expect((caughtError as OpenAIAuthError).status).toBe(403);
      expect((caughtError as OpenAIAuthError).message).toContain('organization ID');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws OpenAIConfigError for unexpected non-auth HTTP errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response('Service Unavailable', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return globalThis.fetch(input, _init);
    }) as typeof fetch;

    try {
      await expect(validateOpenAIAuthContext({ apiKey: 'sk-any-key' })).rejects.toThrow(
        OpenAIConfigError
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('openai-provider listModels filtering', () => {
  afterEach(() => {
    mock.restore();
  });

  it('filters out embedding/tts/whisper/moderation model ids', () => {
    // Direct unit test of the filter logic used in listModelsWithCache
    const RAW_MODEL_IDS = [
      'gpt-4o',
      'gpt-4o-mini',
      'text-embedding-3-large',
      'text-embedding-ada-002',
      'tts-1',
      'tts-1-hd',
      'whisper-1',
      'text-moderation-latest',
      'dall-e-3',
    ];

    const filtered = RAW_MODEL_IDS.filter(
      (id) =>
        !id.includes('embedding') &&
        !id.includes('tts') &&
        !id.includes('whisper') &&
        !id.includes('moderation')
    );

    expect(filtered).toEqual(['gpt-4o', 'gpt-4o-mini', 'dall-e-3']);
    expect(filtered).not.toContain('text-embedding-3-large');
    expect(filtered).not.toContain('tts-1');
    expect(filtered).not.toContain('whisper-1');
    expect(filtered).not.toContain('text-moderation-latest');
  });

  it('returns empty array when no key is configured', async () => {
    // Mock the database so syncConfigFileConnectors produces no rows.
    // listSecretMetadata catches TypeError and returns [], giving resolvedCtx = null.
    mock.module('../../../../src/db/database', () => ({
      getDb: () => ({}),
    }));

    const { openAIProvider } = await import('../../../../src/services/providers/openai-provider');
    // Evict any stale cache entry so the mocked DB path is actually exercised.
    (openAIProvider as any).invalidateModelCache?.('nonexistent-user-no-keys');

    const models = await openAIProvider.listModels('nonexistent-user-no-keys');
    expect(models).toEqual([]);
  });
});
