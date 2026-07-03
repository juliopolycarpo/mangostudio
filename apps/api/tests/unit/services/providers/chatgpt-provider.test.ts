import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../../src/lib/config';
import {
  ChatGptReauthRequiredError,
  type ChatGptTokenBundle,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/oauth-client';
import {
  type ChatGptTokenService,
  setChatGptTokenServiceForTests,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/token-service';
import { CHATGPT_BASE_INSTRUCTIONS } from '../../../../src/services/providers/chatgpt/base-instructions';
import {
  CHATGPT_RESPONSES_POLICY,
  chatGptProvider,
} from '../../../../src/services/providers/chatgpt/index';
import {
  CHATGPT_STATIC_MODEL_IDS,
  ChatGptBackendAuthError,
  fetchChatGptModelIds,
  listChatGptModels,
} from '../../../../src/services/providers/chatgpt/model-catalog';
import { parseResponsesLoopState } from '../../../../src/services/providers/core/responses-protocol/loop-state';
import { streamAgentTurnWithResponses } from '../../../../src/services/providers/core/responses-protocol/stream';
import type { AgentEvent, AgentTurnRequest } from '../../../../src/services/providers/types';
import * as realMetadataNs from '../../../../src/services/secret-store/metadata';
import { makeTokenBundle } from '../../../support/chatgpt';

const realMetadata = { ...realMetadataNs };

afterEach(async () => {
  setChatGptTokenServiceForTests(null);
  await mock.module('../../../../src/services/secret-store/metadata', () => realMetadata);
});

// ---------------------------------------------------------------------------
// Agentic turn — request assembly and stateless loop state
// ---------------------------------------------------------------------------

interface CapturedCall {
  params: Record<string, unknown>;
  headers: Record<string, string> | undefined;
}

type FakeStream = Array<Record<string, unknown>>;

function fakeClient(streams: FakeStream[], calls: CapturedCall[]) {
  let callIndex = 0;
  return {
    responses: {
      create: (params: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
        calls.push({ params, headers: options?.headers });
        const events = streams[Math.min(callIndex, streams.length - 1)] ?? [];
        callIndex += 1;
        return Promise.resolve(
          (async function* () {
            await Promise.resolve();
            for (const ev of events) yield ev;
          })()
        );
      },
    },
  } as unknown as Parameters<typeof streamAgentTurnWithResponses>[0];
}

function agentRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u1',
    modelName: 'gpt-5.5',
    systemPrompt: 'You are the MangoStudio agent.',
    history: [],
    prompt: 'Read the README',
    toolDefinitions: [{ name: 'read_file', description: 'Read a file', parameters: {} }],
    generationConfig: {
      thinkingEnabled: true,
      reasoningEffort: 'xhigh',
      maxOutputTokens: 4096,
    },
    ...overrides,
  };
}

const FUNCTION_CALL_STREAM: FakeStream = [
  {
    type: 'response.output_item.added',
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file' },
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_1',
    arguments: '{"path":"README.md"}',
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      usage: { input_tokens: 42, output_tokens: 7 },
      output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1', summary: [] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      ],
    },
  },
];

const FINAL_TEXT_STREAM: FakeStream = [
  { type: 'response.output_text.delta', delta: 'Done.' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_2',
      usage: { input_tokens: 60, output_tokens: 3 },
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      ],
    },
  },
];

async function collect(
  req: AgentTurnRequest,
  client: Parameters<typeof streamAgentTurnWithResponses>[0]
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of streamAgentTurnWithResponses(client, req, CHATGPT_RESPONSES_POLICY)) {
    events.push(ev);
  }
  return events;
}

describe('chatgpt agentic turn — request policy', () => {
  it('assembles the backend contract: pinned instructions, developer system prompt, no cursor fields', async () => {
    const calls: CapturedCall[] = [];
    const events = await collect(agentRequest(), fakeClient([FUNCTION_CALL_STREAM], calls));

    const params = calls[0]?.params ?? {};
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);
    expect(params.instructions).toBe(CHATGPT_BASE_INSTRUCTIONS);
    expect(params.previous_response_id).toBeUndefined();
    expect(params.max_output_tokens).toBeUndefined();
    expect(params.context_management).toBeUndefined();
    expect(params.include).toEqual(['reasoning.encrypted_content']);
    // xhigh is clamped to the backend's high; summary follows the policy.
    expect(params.reasoning).toEqual({ effort: 'high', summary: 'auto' });

    const input = params.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: 'developer', content: 'You are the MangoStudio agent.' });
    expect(input.at(-1)).toEqual({ role: 'user', content: 'Read the README' });

    expect(calls[0]?.headers?.session_id).toBeTruthy();

    expect(events).toContainEqual({
      type: 'tool_call_started',
      callId: 'call_1',
      name: 'read_file',
    });
    expect(events).toContainEqual({
      type: 'tool_call_completed',
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });
  });

  it('replays turn-local items and keeps the session id across tool iterations', async () => {
    const calls: CapturedCall[] = [];
    const client = fakeClient([FUNCTION_CALL_STREAM, FINAL_TEXT_STREAM], calls);

    const firstEvents = await collect(agentRequest(), client);
    const firstCompleted = firstEvents.find((ev) => ev.type === 'turn_completed');
    const providerState =
      firstCompleted?.type === 'turn_completed' ? (firstCompleted.providerState ?? null) : null;
    expect(providerState).toBeTruthy();

    const loopState = parseResponsesLoopState(providerState, CHATGPT_RESPONSES_POLICY);
    expect(loopState?.sessionId).toBe(calls[0]?.headers?.session_id ?? '');
    // Current input (user message) + this turn's output items.
    expect(loopState?.loopItems).toEqual([
      { role: 'user', content: 'Read the README' },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1', summary: [] },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    ]);

    const secondEvents = await collect(
      agentRequest({
        prompt: undefined,
        providerState,
        toolResults: [{ callId: 'call_1', name: 'read_file', result: '# MangoStudio' }],
      }),
      client
    );

    // Same per-turn session id on both iterations.
    expect(calls[1]?.headers?.session_id).toBe(calls[0]?.headers?.session_id ?? '');

    const secondInput = calls[1]?.params.input as Array<Record<string, unknown>>;
    expect(secondInput[0]).toEqual({
      role: 'developer',
      content: 'You are the MangoStudio agent.',
    });
    // The reasoning item (with encrypted content) and function_call are re-sent
    // before the new function_call_output.
    expect(secondInput).toContainEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'enc_1',
      summary: [],
    });
    expect(secondInput.at(-1)).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '# MangoStudio',
    });

    const secondCompleted = secondEvents.find((ev) => ev.type === 'turn_completed');
    const secondState =
      secondCompleted?.type === 'turn_completed' ? (secondCompleted.providerState ?? null) : null;
    const secondLoopState = parseResponsesLoopState(secondState, CHATGPT_RESPONSES_POLICY);
    expect(secondLoopState?.sessionId).toBe(loopState?.sessionId ?? '');
    expect(secondLoopState?.loopItems).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '# MangoStudio',
    });
  });
});

// ---------------------------------------------------------------------------
// Model catalog — discovery parsing, filtering, and fallback
// ---------------------------------------------------------------------------

describe('chatgpt model catalog', () => {
  const bundle = makeTokenBundle();

  it('parses OpenAI-style payloads and drops plan-gated -pro ids', async () => {
    const ids = await fetchChatGptModelIds(bundle, () =>
      Promise.resolve(
        Response.json({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-pro' }, { id: 'gpt-5.4-mini' }] })
      )
    );
    expect(ids).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  });

  it('parses Codex-style payloads with string and slug entries', async () => {
    const ids = await fetchChatGptModelIds(bundle, () =>
      Promise.resolve(
        Response.json({ models: ['gpt-5.5', { slug: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }] })
      )
    );
    expect(ids).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
  });

  it('throws ChatGptBackendAuthError on 401', async () => {
    await expect(
      fetchChatGptModelIds(bundle, () => Promise.resolve(new Response('nope', { status: 401 })))
    ).rejects.toBeInstanceOf(ChatGptBackendAuthError);
  });

  it('falls back to the static list when discovery is unreachable', async () => {
    getConfig().chatgpt.apiBaseUrl = 'http://127.0.0.1:1';
    const models = await listChatGptModels(bundle);
    expect(models.map((m) => m.modelId)).toEqual([...CHATGPT_STATIC_MODEL_IDS]);
    expect(models[0]?.capabilities).toMatchObject({
      reasoning: true,
      tools: true,
      parallelToolCalls: true,
      statefulContinuation: false,
      promptCaching: false,
      structuredOutput: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 401 policy — force refresh once, retry once, then reauth-required
// ---------------------------------------------------------------------------

function connectorRow(): SecretMetadataRow {
  return {
    id: 'chatgpt-connector-1',
    name: 'chatgpt-test',
    provider: 'chatgpt',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: null,
    updatedAt: Date.now(),
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: '[]',
    userId: 'user-1',
    baseUrl: null,
  };
}

interface FakeBackendState {
  requests: Array<{ authorization: string | null; accountId: string | null }>;
  behavior: (callCount: number) => Response;
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function unauthorizedResponse(): Response {
  return Response.json({ error: { message: 'token expired' } }, { status: 401 });
}

describe('chatgpt provider — 401 refresh/retry policy', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  const state: FakeBackendState = { requests: [], behavior: () => unauthorizedResponse() };
  let forceRefreshCalls = 0;

  function installTokenService(bundles: {
    fresh: ChatGptTokenBundle;
    rotated: ChatGptTokenBundle;
  }) {
    const service: ChatGptTokenService = {
      ensureFreshTokens: () => Promise.resolve(bundles.fresh),
      forceRefreshTokens: () => {
        forceRefreshCalls += 1;
        return Promise.resolve(bundles.rotated);
      },
      readBundle: () => Promise.resolve(bundles.fresh),
      persistBundle: () => Promise.resolve(),
      deleteBundle: () => Promise.resolve(true),
    };
    setChatGptTokenServiceForTests(service);
  }

  beforeEach(async () => {
    state.requests = [];
    forceRefreshCalls = 0;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        state.requests.push({
          authorization: request.headers.get('authorization'),
          accountId: request.headers.get('chatgpt-account-id'),
        });
        return state.behavior(state.requests.length);
      },
    });
    getConfig().chatgpt.apiBaseUrl = `http://127.0.0.1:${server.port}`;

    await mock.module('../../../../src/services/secret-store/metadata', () => ({
      ...realMetadata,
      listSecretMetadata: () => Promise.resolve([connectorRow()]),
    }));
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  it('force-refreshes once and retries after a 401, using the rotated token', async () => {
    const fresh = makeTokenBundle({ accessToken: 'stale-access-token' });
    const rotated = makeTokenBundle({ accessToken: 'rotated-access-token' });
    installTokenService({ fresh, rotated });

    state.behavior = (callCount) =>
      callCount === 1
        ? unauthorizedResponse()
        : sseResponse([
            { type: 'response.output_text.delta', delta: 'Hello!' },
            { type: 'response.completed', response: { id: 'resp_1', output: [] } },
          ]);

    let text = '';
    for await (const chunk of chatGptProvider.generateTextStream?.({
      userId: 'user-1',
      modelName: 'gpt-5.5',
      history: [],
      prompt: 'Hi',
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    }) ?? []) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }

    expect(text).toBe('Hello!');
    expect(forceRefreshCalls).toBe(1);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[0]?.authorization).toBe('Bearer stale-access-token');
    expect(state.requests[1]?.authorization).toBe('Bearer rotated-access-token');
    expect(state.requests[1]?.accountId).toBe(rotated.accountId);
  });

  it('surfaces ChatGptReauthRequiredError when the retry is rejected too', async () => {
    installTokenService({
      fresh: makeTokenBundle({ accessToken: 'stale-access-token-2' }),
      rotated: makeTokenBundle({ accessToken: 'rotated-access-token-2' }),
    });
    state.behavior = () => unauthorizedResponse();

    const consume = async () => {
      for await (const _chunk of chatGptProvider.generateTextStream?.({
        userId: 'user-1',
        modelName: 'gpt-5.5',
        history: [],
        prompt: 'Hi',
        generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
      }) ?? []) {
        // drain
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(ChatGptReauthRequiredError);
  });
});

afterAll(() => {
  setChatGptTokenServiceForTests(null);
});
