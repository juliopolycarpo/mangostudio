import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { createProviderSecretService } from '../../../../src/services/providers/core/secret-service';
import { createCompatibleClient } from '../../../../src/services/providers/openai-compatible/client';
import { resolveCompatibleClientConfig } from '../../../../src/services/providers/openai-compatible/resolve-client-config';
import type { AgentEvent, AgentTurnRequest } from '../../../../src/services/providers/types';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';
import { collectAgentEvents } from '../../../support/providers/agent-event-collector';
import { expectTurnCompletedEnvelope } from '../../../support/providers/contract-assertions';
import {
  chainChunks,
  createFakeChatCompletionsClient,
  stopChunk,
  textDeltaChunk,
  toolCallArgumentsDeltaChunk,
  toolCallStartChunk,
  usageChunk,
} from '../../../support/providers/fake-chat-completions';

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

interface CaptureCall {
  args?: Record<string, unknown>;
}

function parseProviderState(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function findAssistantMsg(state: Record<string, unknown>): Record<string, unknown> | undefined {
  const loopMessages = state.loopMessages as Array<Record<string, unknown>> | undefined;
  return loopMessages?.find((message) => message.role === 'assistant');
}

function baseTurnRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u',
    modelName: 'gpt-4o',
    systemPrompt: undefined,
    history: [],
    prompt: 'Hello',
    toolDefinitions: [],
    providerState: null,
    signal: new AbortController().signal,
    generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    ...overrides,
  };
}

async function collectCompatEvents(
  stream: AsyncIterable<Record<string, unknown>>,
  overrides: Partial<AgentTurnRequest> = {},
  capture: CaptureCall = {}
): Promise<AgentEvent[]> {
  const { streamOAICompatAgentTurn } = await import(
    '../../../../src/services/providers/openai-compatible/chat-completions-stream'
  );
  const client = createFakeChatCompletionsClient((args) => {
    capture.args = args;
    return Promise.resolve(stream);
  });

  return collectAgentEvents(
    streamOAICompatAgentTurn(
      client as unknown as Parameters<typeof streamOAICompatAgentTurn>[0],
      baseTurnRequest(overrides)
    )
  );
}

describe('openai-compatible-provider', () => {
  it('reuses the same client for the same base URL and API key', () => {
    const clientA = createCompatibleClient('sk-test-openrouter-cache', OPENROUTER_BASE_URL);
    const clientB = createCompatibleClient('sk-test-openrouter-cache', OPENROUTER_BASE_URL);

    expect(clientA).toBe(clientB);
  });

  it('creates a different client when the base URL changes', () => {
    const openRouterClient = createCompatibleClient(
      'sk-test-openrouter-cache-2',
      OPENROUTER_BASE_URL
    );
    const deepSeekClient = createCompatibleClient('sk-test-openrouter-cache-2', DEEPSEEK_BASE_URL);

    expect(openRouterClient).not.toBe(deepSeekClient);
  });

  it('providerType is openai-compatible', async () => {
    const { openAICompatibleProvider } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(openAICompatibleProvider.providerType).toBe('openai-compatible');
  });

  it('is registered in the provider registry after import', async () => {
    await import('../../../../src/services/providers/openai-compatible/index');
    const { getProvider } = await import(
      '../../../../src/services/providers/core/provider-registry'
    );
    const provider = getProvider('openai-compatible');
    expect(provider.providerType).toBe('openai-compatible');
  });

  it('implements the required AIProvider methods', async () => {
    const { openAICompatibleProvider } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
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
    const rowWithoutUrl = makeCompatRow({ baseUrl: null });

    await (expect(
      resolveCompatibleClientConfig([rowWithoutUrl], () => Promise.resolve('sk-test'))
    ).rejects.toThrow(
      'No openai-compatible connector with a valid baseUrl is configured for this model.'
    ) as unknown as Promise<void>);
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

    const resolved = await resolveCompatibleClientConfig(
      [rowA, rowB],
      (row) => Promise.resolve(`key-for-${row.id}`),
      'deepseek-chat'
    );

    expect(resolved).toEqual({ apiKey: 'key-for-compat-b', baseUrl: DEEPSEEK_BASE_URL });
  });

  it('does NOT fall back to https://api.openai.com/v1', async () => {
    let thrownError: unknown = null;
    try {
      await resolveCompatibleClientConfig([], () => Promise.resolve('sk-test'));
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).not.toContain('api.openai.com');
    expect((thrownError as Error).message).toContain('baseUrl');
  });
});

describe('openai-compatible generateAgentTurnStream turn_completed contract', () => {
  it('emits turn_completed with mode=stateless-loop', async () => {
    const events = await collectCompatEvents(chainChunks(textDeltaChunk('Hi'), stopChunk()), {
      userId: 'test-user-no-connectors',
      modelName: 'test-model',
    });

    expectTurnCompletedEnvelope(events, {
      provider: 'openai-compatible',
      mode: 'stateless-loop',
    });
  });
});

describe('openai-compatible chat-completions-stream events', () => {
  it('yields reasoning_delta and assistant_text_delta', async () => {
    const events = await collectCompatEvents(
      chainChunks(
        (function* () {
          yield {
            choices: [
              { delta: { reasoning: 'Think first', content: 'Final answer' }, finish_reason: null },
            ],
          };
        })(),
        stopChunk()
      )
    );

    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Think first' });
    expect(events).toContainEqual({ type: 'assistant_text_delta', text: 'Final answer' });
  });

  it('yields tool call started, arguments delta, and completed events', async () => {
    const events = await collectCompatEvents(
      chainChunks(
        toolCallStartChunk(0, 'call_1', 'search'),
        toolCallArgumentsDeltaChunk(0, '{"query":"cats"}'),
        stopChunk()
      )
    );

    expect(events).toContainEqual({ type: 'tool_call_started', callId: 'call_1', name: 'search' });
    expect(events).toContainEqual({
      type: 'tool_call_arguments_delta',
      callId: 'call_1',
      delta: '{"query":"cats"}',
    });
    expect(events).toContainEqual({
      type: 'tool_call_completed',
      callId: 'call_1',
      name: 'search',
      arguments: '{"query":"cats"}',
    });
  });

  it('preserves reasoning_content in loop state when tool calls are present', async () => {
    const events = await collectCompatEvents(
      chainChunks(
        (function* () {
          yield {
            choices: [
              {
                delta: {
                  reasoning_content: 'Thinking about tools',
                  tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search' } }],
                },
                finish_reason: null,
              },
            ],
          };
        })(),
        toolCallArgumentsDeltaChunk(0, '{"q":"test"}'),
        stopChunk()
      )
    );

    const completed = events.find((event) => event.type === 'turn_completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'turn_completed') return;
    if (!completed.providerState) throw new Error('expected providerState');

    const assistantMsg = findAssistantMsg(parseProviderState(completed.providerState));
    expect(assistantMsg?.reasoning_content).toBe('Thinking about tools');
    expect(assistantMsg?.tool_calls).toHaveLength(1);
  });

  it('omits reasoning_content from final assistant message when no tool calls are present', async () => {
    const events = await collectCompatEvents(
      chainChunks(
        (function* () {
          yield {
            choices: [
              {
                delta: { reasoning_content: 'Private reasoning', content: 'Answer here' },
                finish_reason: null,
              },
            ],
          };
        })(),
        stopChunk()
      )
    );

    const completed = events.find((event) => event.type === 'turn_completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'turn_completed') return;
    if (!completed.providerState) throw new Error('expected providerState');

    const assistantMsg = findAssistantMsg(parseProviderState(completed.providerState));
    expect(assistantMsg?.reasoning_content).toBeUndefined();
  });

  it('stops on abort without emitting turn_completed', async () => {
    const controller = new AbortController();
    const events = await collectCompatEvents(
      (async function* () {
        await Promise.resolve();
        yield { choices: [{ delta: { content: 'First' }, finish_reason: null }] };
        controller.abort();
        yield { choices: [{ delta: { content: 'Second' }, finish_reason: 'stop' }] };
      })(),
      { signal: controller.signal }
    );

    expect(events.filter((event) => event.type === 'assistant_text_delta')).toHaveLength(1);
    expect(events.some((event) => event.type === 'turn_completed')).toBe(false);
  });
});

describe('openai-compatible chat-completions-stream token accounting', () => {
  it('sets stream_options.include_usage on chat.completions.create', async () => {
    const capture: CaptureCall = {};
    await collectCompatEvents(chainChunks(textDeltaChunk('Hi'), stopChunk()), {}, capture);

    expect(capture.args).toBeDefined();
    expect(capture.args?.stream).toBe(true);
    expect(capture.args?.stream_options).toEqual({ include_usage: true });
  });

  it('populates context.providerReportedInputTokens in the envelope when usage is reported', async () => {
    const capture: CaptureCall = {};
    const events = await collectCompatEvents(
      chainChunks(textDeltaChunk('Hi'), stopChunk(), usageChunk(1234, 5)),
      {},
      capture
    );

    const envelope = expectTurnCompletedEnvelope(events, {
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      providerReportedInputTokens: 1234,
    });
    expect(envelope?.context?.contextLimit).toBe(128_000);
  });

  it('omits context when usage is not reported by the endpoint', async () => {
    const capture: CaptureCall = {};
    const events = await collectCompatEvents(
      chainChunks(textDeltaChunk('Hi'), stopChunk()),
      {},
      capture
    );

    const envelope = expectTurnCompletedEnvelope(events, {
      provider: 'openai-compatible',
      mode: 'stateless-loop',
    });
    expect(envelope?.context).toBeUndefined();
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

  it('does not resolve an unconfigured connector', async () => {
    await (expect(
      resolveCompatibleClientConfig([makeCompatRow({ configured: 0 })], () =>
        Promise.resolve('sk-test')
      )
    ).rejects.toThrow(
      'No openai-compatible connector with a valid baseUrl is configured for this model.'
    ) as unknown as Promise<void>);
  });
});

describe('classifyEndpoint', () => {
  it('classifies DeepSeek base URLs', async () => {
    const { classifyEndpoint } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(classifyEndpoint('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(classifyEndpoint('https://api.deepseek.com')).toBe('deepseek');
  });

  it('classifies OpenRouter base URLs', async () => {
    const { classifyEndpoint } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(classifyEndpoint('https://openrouter.ai/api/v1')).toBe('openrouter');
  });

  it('classifies unknown endpoints as generic', async () => {
    const { classifyEndpoint } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(classifyEndpoint('https://my-custom-llm.example.com/v1')).toBe('generic');
    expect(classifyEndpoint('http://localhost:11434')).toBe('generic');
  });

  it('does not classify deceptive hostnames that embed provider domains', async () => {
    const { classifyEndpoint } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(classifyEndpoint('https://api.deepseek.com.evil.test/v1')).toBe('generic');
    expect(classifyEndpoint('https://evil.test/?next=openrouter.ai')).toBe('generic');
    expect(classifyEndpoint('https://deepseek.com.attacker.example/v1')).toBe('generic');
  });

  it('classifies provider subdomains correctly', async () => {
    const { classifyEndpoint } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(classifyEndpoint('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(classifyEndpoint('https://openrouter.ai/api/v1')).toBe('openrouter');
  });

  it('classifies malformed base URLs as generic', async () => {
    const { classifyEndpoint } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(classifyEndpoint('not-a-url')).toBe('generic');
  });
});

describe('extractReasoningChunks', () => {
  it('extracts from delta.reasoning_content', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    const chunks = extractReasoningChunks({ reasoning_content: 'thinking step 1' });
    expect(chunks).toEqual(['thinking step 1']);
  });

  it('extracts from delta.reasoning (OpenRouter normalized)', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    const chunks = extractReasoningChunks({ reasoning: 'openrouter thinking' });
    expect(chunks).toEqual(['openrouter thinking']);
  });

  it('prefers reasoning_content over reasoning when both present', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    // The || short-circuits: if reasoning_content is non-empty, reasoning is not used
    const chunks = extractReasoningChunks({
      reasoning_content: 'primary',
      reasoning: 'secondary',
    });
    expect(chunks).toEqual(['primary']);
  });

  it('falls back to delta.reasoning when reasoning_content is empty string', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    const chunks = extractReasoningChunks({ reasoning_content: '', reasoning: 'fallback' });
    expect(chunks).toEqual(['fallback']);
  });

  it('extracts reasoning.text entries from delta.reasoning_details', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    const chunks = extractReasoningChunks({
      reasoning_details: [
        { type: 'reasoning.text', text: 'step A' },
        { type: 'reasoning.text', text: 'step B' },
      ],
    });
    expect(chunks).toEqual(['step A', 'step B']);
  });

  it('extracts reasoning.summary entries from delta.reasoning_details', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    const chunks = extractReasoningChunks({
      reasoning_details: [{ type: 'reasoning.summary', text: 'summary text' }],
    });
    expect(chunks).toEqual(['summary text']);
  });

  it('skips reasoning_details entries with unknown type', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    const chunks = extractReasoningChunks({
      reasoning_details: [{ type: 'unknown.type', text: 'ignored' }],
    });
    expect(chunks).toEqual([]);
  });

  it('returns empty array when delta has no reasoning fields', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
    expect(extractReasoningChunks({ content: 'Hello' })).toEqual([]);
    expect(extractReasoningChunks({})).toEqual([]);
  });

  it('combines simple field and reasoning_details in one delta', async () => {
    const { extractReasoningChunks } = await import(
      '../../../../src/services/providers/openai-compatible/index'
    );
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
    const { isImageModelId, isReasoningModel } = await import(
      '@mangostudio/shared/utils/model-detection'
    );

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
    const { isImageModelId, isReasoningModel } = await import(
      '@mangostudio/shared/utils/model-detection'
    );

    const imageModelId = 'dall-e-3';
    const isImage = isImageModelId(imageModelId);
    expect(isImage).toBe(true);

    // parallelToolCalls: !isImage → false
    expect(!isImage).toBe(false);
    // reasoningWithTools: isReasoningModel && !isImage → false
    expect(isReasoningModel(imageModelId) && !isImage).toBe(false);
  });

  it('sets parallelToolCalls=true and reasoningWithTools=true for deepseek-r1', async () => {
    const { isImageModelId, isReasoningModel } = await import(
      '@mangostudio/shared/utils/model-detection'
    );

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
