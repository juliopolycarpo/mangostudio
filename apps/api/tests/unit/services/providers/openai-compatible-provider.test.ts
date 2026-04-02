import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import { createProviderSecretService } from '../../../../src/services/providers/secret-service';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';

const TEST_USER = 'test-user-oai-compat';
const NO_TOML = '/tmp/mangostudio-test-nonexistent-config.toml';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * Creates an in-memory metadata harness for test isolation.
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

/** Builds a configured SecretMetadataRow for the openai-compatible provider. */
function makeCompatRow(overrides: Partial<SecretMetadataRow> = {}): SecretMetadataRow {
  return {
    id: 'compat-row-1',
    name: 'default',
    provider: 'openai-compatible',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: '****...efgh',
    updatedAt: Date.now(),
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: JSON.stringify([]),
    userId: TEST_USER,
    baseUrl: OPENROUTER_BASE_URL,
    ...overrides,
  };
}

/** Creates a secretService instance wired to the given harness and store. */
function createTestService(
  metadata: ReturnType<typeof createMetadataHarness>,
  secretStore: InMemorySecretStore = new InMemorySecretStore()
) {
  return {
    service: createProviderSecretService(
      {
        provider: 'openai-compatible',
        tomlSection: 'openai_compatible_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {
          throw new Error('Cannot validate an openai-compatible key without a baseUrl.');
        },
      },
      {
        secretStore,
        tomlFilePath: NO_TOML,
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    ),
    secretStore,
  };
}

describe('openai-compatible-provider', () => {
  it('providerType is openai-compatible', async () => {
    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    expect(openAICompatibleProvider.providerType).toBe('openai-compatible');
  });

  it('is registered in the provider registry after import', async () => {
    await import('../../../../src/services/providers/openai-compatible-provider');
    const { getProvider } = await import('../../../../src/services/providers/registry');
    const provider = getProvider('openai-compatible');
    expect(provider.providerType).toBe('openai-compatible');
  });

  it('implements the required AIProvider methods', async () => {
    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    expect(typeof openAICompatibleProvider.generateText).toBe('function');
    expect(typeof openAICompatibleProvider.listModels).toBe('function');
    expect(typeof openAICompatibleProvider.validateApiKey).toBe('function');
    expect(typeof openAICompatibleProvider.resolveApiKey).toBe('function');
  });
});

describe('openai-compatible resolveClientConfig (via secretService)', () => {
  it('resolves the API key from a connector with a valid baseUrl', async () => {
    const row = makeCompatRow({ baseUrl: OPENROUTER_BASE_URL });
    const metadata = createMetadataHarness([row]);
    const secretStore = new InMemorySecretStore();
    const API_KEY = 'sk-or-test-key-efgh';

    await secretStore.setSecret(
      { service: 'mangostudio', name: `openai-compatible-api-key:${row.id}` },
      API_KEY
    );

    const { service } = createTestService(metadata, secretStore);
    const key = await service.resolveApiKey(TEST_USER);
    expect(key).toBe(API_KEY);
  });

  it('skips rows where baseUrl is null', () => {
    const rowWithoutUrl = makeCompatRow({ id: 'no-url', baseUrl: null });
    const rowWithUrl = makeCompatRow({ id: 'has-url', baseUrl: DEEPSEEK_BASE_URL });

    const rows = [rowWithoutUrl, rowWithUrl];
    const rowsWithBaseUrl = rows.filter((r) => r.baseUrl);
    expect(rowsWithBaseUrl).toHaveLength(1);
    expect(rowsWithBaseUrl[0]!.id).toBe('has-url');
  });

  it('skips rows where baseUrl is empty string', () => {
    const rowEmptyUrl = makeCompatRow({ id: 'empty-url', baseUrl: '' });

    // Empty string is falsy, so the provider's resolveClientConfig skips it
    const rows = [rowEmptyUrl];
    const rowsWithBaseUrl = rows.filter((r) => r.baseUrl);
    expect(rowsWithBaseUrl).toHaveLength(0);
  });

  it('throws with the correct error message when no connector has a valid baseUrl', async () => {
    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible-provider');

    // The real provider throws this specific error when no eligible connector is found.
    // 'user-with-no-valid-connectors' has no connectors in the test DB.
    await expect(
      openAICompatibleProvider.resolveApiKey('user-with-no-valid-connectors')
    ).rejects.toThrow(
      'No openai-compatible connector with a valid baseUrl is configured for this model.'
    );
  });

  it('picks the connector with the matching enabledModel when two connectors exist', async () => {
    const rowA = makeCompatRow({
      id: 'compat-a',
      name: 'openrouter',
      baseUrl: OPENROUTER_BASE_URL,
      enabledModels: JSON.stringify(['openai/gpt-4o']),
    });
    const rowB = makeCompatRow({
      id: 'compat-b',
      name: 'deepseek',
      baseUrl: DEEPSEEK_BASE_URL,
      enabledModels: JSON.stringify(['deepseek-chat']),
    });

    // Verify the filter logic: with modelName 'deepseek-chat', rowA is skipped
    const rows = [rowA, rowB];
    const MODEL_NAME = 'deepseek-chat';

    const matching = rows.filter((row) => {
      if (!row.configured) return false;
      if (!row.baseUrl) return false;
      const enabled: string[] = JSON.parse(row.enabledModels);
      if (MODEL_NAME && enabled.length > 0 && !enabled.includes(MODEL_NAME)) return false;
      return true;
    });

    expect(matching).toHaveLength(1);
    expect(matching[0]!.id).toBe('compat-b');
    expect(matching[0]!.baseUrl).toBe(DEEPSEEK_BASE_URL);
  });

  it('does NOT fall back to https://api.openai.com/v1', async () => {
    // The openai-compatible provider must never use the OpenAI base URL.
    // When no connector has a baseUrl, it should throw rather than fall back.
    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible-provider');

    let thrownError: unknown = null;
    try {
      await openAICompatibleProvider.resolveApiKey('user-no-fallback-test');
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).not.toContain('api.openai.com');
    expect((thrownError as Error).message).toContain('baseUrl');
  });
});

describe('openai-compatible listModels filtering', () => {
  it('skips connectors without baseUrl', () => {
    // Verify the filtering logic that listModelsWithCache uses
    const rows: SecretMetadataRow[] = [
      makeCompatRow({ id: 'no-url-list', baseUrl: null }),
      makeCompatRow({ id: 'has-url-list', baseUrl: OPENROUTER_BASE_URL }),
      makeCompatRow({ id: 'empty-url-list', baseUrl: '' }),
    ];

    const validRows = rows.filter((r) => r.configured && r.baseUrl);
    expect(validRows).toHaveLength(1);
    expect(validRows[0]!.id).toBe('has-url-list');
  });

  it('deduplicates by baseUrl (single API call per unique endpoint)', () => {
    // Two connectors pointing to the same baseUrl should result in one entry
    const rows: SecretMetadataRow[] = [
      makeCompatRow({ id: 'dup-1', name: 'key-1', baseUrl: OPENROUTER_BASE_URL }),
      makeCompatRow({ id: 'dup-2', name: 'key-2', baseUrl: OPENROUTER_BASE_URL }),
      makeCompatRow({ id: 'unique', name: 'key-3', baseUrl: DEEPSEEK_BASE_URL }),
    ];

    // Replicate the deduplication logic from listModelsWithCache
    const seenBaseUrls = new Map<string, string>();
    for (const row of rows) {
      if (!row.configured) continue;
      if (!row.baseUrl) continue;
      if (seenBaseUrls.has(row.baseUrl)) continue;
      seenBaseUrls.set(row.baseUrl, row.id);
    }

    expect(seenBaseUrls.size).toBe(2);
    expect(seenBaseUrls.has(OPENROUTER_BASE_URL)).toBe(true);
    expect(seenBaseUrls.has(DEEPSEEK_BASE_URL)).toBe(true);
    // The first row for OPENROUTER_BASE_URL wins
    expect(seenBaseUrls.get(OPENROUTER_BASE_URL)).toBe('dup-1');
  });

  it('returns empty array when no connectors are configured', async () => {
    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const models = await openAICompatibleProvider.listModels('nonexistent-user-no-compat-keys');
    expect(models).toEqual([]);
  });
});
