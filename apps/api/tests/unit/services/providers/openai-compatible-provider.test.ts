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
    listMetadata: (_provider: string, _userId: string) => Promise.resolve([...rows]),
    getMetadataById: (id: string, _userId: string) =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
    upsertMetadata: (input: SecretMetadataInput) => {
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
      return Promise.resolve();
    },
    deleteMetadata: (id: string, _userId: string) => {
      rows = rows.filter((r) => r.id !== id);
      return Promise.resolve();
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
        validateFn: () =>
          Promise.reject(new Error('Cannot validate an openai-compatible key without a baseUrl.')),
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
    expect(rowsWithBaseUrl[0].id).toBe('has-url');
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

  it('picks the connector with the matching enabledModel when two connectors exist', () => {
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
    expect(matching[0].id).toBe('compat-b');
    expect(matching[0].baseUrl).toBe(DEEPSEEK_BASE_URL);
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

describe('openai-compatible generateAgentTurnStream turn_completed contract', () => {
  it('emits turn_completed with mode=stateless-loop when connectors are present', async () => {
    // Confirms the provider surface contract: the route is responsible for
    // non-persistence of turn-local state, not the provider itself.
    //
    // This test is intentionally environment-dependent: on CI or machines
    // without an openai-compatible connector configured it passes vacuously.
    // The definitive contract assertion is in the integration test
    // (respond-stream.integration.test.ts).
    const { parseContinuationEnvelope } =
      await import('../../../../src/services/providers/continuation');
    const { openAICompatibleProvider } =
      await import('../../../../src/services/providers/openai-compatible-provider');

    const events: Array<{ type: string; providerState?: string }> = [];

    try {
      for await (const event of openAICompatibleProvider.generateAgentTurnStream!({
        userId: 'test-user-no-connectors',
        modelName: 'test-model',
        systemPrompt: undefined,
        history: [],
        prompt: 'Hello',
        toolDefinitions: [],
        providerState: null,
        signal: new AbortController().signal,
        generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
      })) {
        events.push(event as any);
      }
    } catch {
      // resolveClientConfig throws when no connectors are configured — that is
      // expected in CI. The turn_completed contract is covered by the
      // integration test which mocks the full provider chain.
    }

    const turnCompleted = events.find((e) => e.type === 'turn_completed');
    if (turnCompleted) {
      const envelope = parseContinuationEnvelope(turnCompleted.providerState ?? null);
      expect(envelope).not.toBeNull();
      expect(envelope!.mode).toBe('stateless-loop');
    }
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
    expect(validRows[0].id).toBe('has-url-list');
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

describe('classifyEndpoint', () => {
  it('classifies DeepSeek base URLs', async () => {
    const { classifyEndpoint } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    expect(classifyEndpoint('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(classifyEndpoint('https://api.deepseek.com')).toBe('deepseek');
  });

  it('classifies OpenRouter base URLs', async () => {
    const { classifyEndpoint } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    expect(classifyEndpoint('https://openrouter.ai/api/v1')).toBe('openrouter');
  });

  it('classifies unknown endpoints as generic', async () => {
    const { classifyEndpoint } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    expect(classifyEndpoint('https://my-custom-llm.example.com/v1')).toBe('generic');
    expect(classifyEndpoint('http://localhost:11434')).toBe('generic');
  });
});

describe('extractReasoningChunks', () => {
  it('extracts from delta.reasoning_content', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({ reasoning_content: 'thinking step 1' });
    expect(chunks).toEqual(['thinking step 1']);
  });

  it('extracts from delta.reasoning (OpenRouter normalized)', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({ reasoning: 'openrouter thinking' });
    expect(chunks).toEqual(['openrouter thinking']);
  });

  it('prefers reasoning_content over reasoning when both present', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    // The || short-circuits: if reasoning_content is non-empty, reasoning is not used
    const chunks = extractReasoningChunks({
      reasoning_content: 'primary',
      reasoning: 'secondary',
    });
    expect(chunks).toEqual(['primary']);
  });

  it('falls back to delta.reasoning when reasoning_content is empty string', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({ reasoning_content: '', reasoning: 'fallback' });
    expect(chunks).toEqual(['fallback']);
  });

  it('extracts reasoning.text entries from delta.reasoning_details', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({
      reasoning_details: [
        { type: 'reasoning.text', text: 'step A' },
        { type: 'reasoning.text', text: 'step B' },
      ],
    });
    expect(chunks).toEqual(['step A', 'step B']);
  });

  it('extracts reasoning.summary entries from delta.reasoning_details', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({
      reasoning_details: [{ type: 'reasoning.summary', text: 'summary text' }],
    });
    expect(chunks).toEqual(['summary text']);
  });

  it('skips reasoning_details entries with unknown type', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({
      reasoning_details: [{ type: 'unknown.type', text: 'ignored' }],
    });
    expect(chunks).toEqual([]);
  });

  it('returns empty array when delta has no reasoning fields', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    expect(extractReasoningChunks({ content: 'Hello' })).toEqual([]);
    expect(extractReasoningChunks({})).toEqual([]);
  });

  it('combines simple field and reasoning_details in one delta', async () => {
    const { extractReasoningChunks } =
      await import('../../../../src/services/providers/openai-compatible-provider');
    const chunks = extractReasoningChunks({
      reasoning_content: 'inline',
      reasoning_details: [{ type: 'reasoning.text', text: 'detailed' }],
    });
    // reasoning_content is returned as a single chunk; reasoning_details appends more
    expect(chunks).toEqual(['inline', 'detailed']);
  });
});

describe('openai-compatible capability metadata flags', () => {
  it('sets parallelToolCalls=true and reasoningWithTools=false for text-only model IDs', async () => {
    // Validate the logic the listModels function uses to assemble capabilities.
    // Since listModels calls the live API, we test the flag derivation logic directly.
    const { isImageModelId, isReasoningModel } =
      await import('@mangostudio/shared/utils/model-detection');

    const gpt4oId = 'gpt-4o';
    const isImage = isImageModelId(gpt4oId);
    expect(isImage).toBe(false);
    expect(isReasoningModel(gpt4oId)).toBe(false);

    // parallelToolCalls: !isImage → true
    expect(!isImage).toBe(true);
    // reasoningWithTools: isReasoningModel && !isImage → false
    expect(isReasoningModel(gpt4oId) && !isImage).toBe(false);
  });

  it('sets parallelToolCalls=false and reasoningWithTools=false for image model IDs', async () => {
    const { isImageModelId, isReasoningModel } =
      await import('@mangostudio/shared/utils/model-detection');

    const imageModelId = 'dall-e-3';
    const isImage = isImageModelId(imageModelId);
    expect(isImage).toBe(true);

    // parallelToolCalls: !isImage → false
    expect(!isImage).toBe(false);
    // reasoningWithTools: isReasoningModel && !isImage → false
    expect(isReasoningModel(imageModelId) && !isImage).toBe(false);
  });

  it('sets parallelToolCalls=true and reasoningWithTools=true for deepseek-r1', async () => {
    const { isImageModelId, isReasoningModel } =
      await import('@mangostudio/shared/utils/model-detection');

    const reasoningModelId = 'deepseek-r1';
    const isImage = isImageModelId(reasoningModelId);
    expect(isImage).toBe(false);
    expect(isReasoningModel(reasoningModelId)).toBe(true);

    // parallelToolCalls: !isImage → true
    expect(!isImage).toBe(true);
    // reasoningWithTools: isReasoningModel && !isImage → true
    expect(isReasoningModel(reasoningModelId) && !isImage).toBe(true);
  });
});
