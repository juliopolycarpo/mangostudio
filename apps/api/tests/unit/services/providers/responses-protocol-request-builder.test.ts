import { describe, expect, it } from 'bun:test';
import {
  parseResponsesLoopState,
  serializeResponsesTurnState,
} from '../../../../src/services/providers/core/responses-protocol/loop-state';
import {
  buildResponsesAgentTurnInput,
  buildResponsesCreateParams,
  buildResponsesRequestOptions,
  normalizeResponsesReasoningEffort,
  type ResponsesRequestPolicy,
  resolveResponsesInstructions,
} from '../../../../src/services/providers/core/responses-protocol/request-builder';
import type { AgentTurnRequest } from '../../../../src/services/providers/types';

const OPENAI_POLICY: ResponsesRequestPolicy = {
  provider: 'openai',
  store: true,
  continuation: 'previous-response-id',
  instructions: 'system-prompt',
  allowMaxOutputTokens: true,
};

const CHATGPT_POLICY: ResponsesRequestPolicy = {
  provider: 'chatgpt',
  store: false,
  continuation: 'stateless-replay',
  instructions: { pinned: 'You are ChatGPT, a large language model.' },
  systemPromptRole: 'developer',
  include: ['reasoning.encrypted_content'],
  allowMaxOutputTokens: false,
  reasoningEffortCeiling: 'high',
  extraHeaders: (ctx): Record<string, string> =>
    ctx.sessionId ? { session_id: ctx.sessionId } : {},
};

function baseAgentRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u1',
    modelName: 'gpt-5',
    history: [],
    prompt: 'Hello',
    generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    ...overrides,
  };
}

describe('buildResponsesCreateParams', () => {
  it('uses the previous-response-id policy for durable OpenAI requests', () => {
    const params = buildResponsesCreateParams({
      model: 'gpt-5',
      input: [{ role: 'user', content: 'Hello' }],
      instructions: resolveResponsesInstructions('Be concise.', OPENAI_POLICY),
      policy: OPENAI_POLICY,
      previousResponseId: 'resp_prev',
      maxOutputTokens: 1234,
      contextLimit: 10_000,
    });

    expect(params.store).toBe(true);
    expect(params.instructions).toBe('Be concise.');
    expect(params.previous_response_id).toBe('resp_prev');
    expect(params.max_output_tokens).toBe(1234);
    expect(params.context_management).toEqual([{ type: 'compaction', compact_threshold: 8500 }]);
  });

  it('applies stateless policy params without cursor-only fields', () => {
    const params = buildResponsesCreateParams({
      model: 'gpt-5',
      input: [{ role: 'user', content: 'Hello' }],
      instructions: resolveResponsesInstructions('Ignored system prompt.', CHATGPT_POLICY),
      policy: CHATGPT_POLICY,
      previousResponseId: 'resp_ignored',
      maxOutputTokens: 1234,
      contextLimit: 10_000,
    });

    expect(params.store).toBe(false);
    expect(params.instructions).toBe('You are ChatGPT, a large language model.');
    expect(params.include).toEqual(['reasoning.encrypted_content']);
    expect(params.previous_response_id).toBeUndefined();
    expect(params.max_output_tokens).toBeUndefined();
    expect(params.context_management).toBeUndefined();
  });
});

describe('buildResponsesCreateParams — parallel tool calls', () => {
  it('emits parallel_tool_calls only when tools are present and a value is set', () => {
    const base = {
      model: 'gpt-5',
      input: [{ role: 'user', content: 'Hello' }],
      policy: CHATGPT_POLICY,
      contextLimit: 10_000,
    };
    const tools = [{ type: 'function', name: 'search' }];

    expect(buildResponsesCreateParams({ ...base, tools, parallelToolCalls: false })).toMatchObject({
      parallel_tool_calls: false,
    });
    expect(buildResponsesCreateParams({ ...base, tools }).parallel_tool_calls).toBeUndefined();
    expect(
      buildResponsesCreateParams({ ...base, parallelToolCalls: true }).parallel_tool_calls
    ).toBeUndefined();
  });
});

describe('normalizeResponsesReasoningEffort', () => {
  it('clamps efforts above the policy ceiling and keeps lower efforts intact', () => {
    expect(normalizeResponsesReasoningEffort('xhigh', 'high')).toBe('high');
    expect(normalizeResponsesReasoningEffort('max', 'high')).toBe('high');
    expect(normalizeResponsesReasoningEffort('medium', 'high')).toBe('medium');
    expect(normalizeResponsesReasoningEffort('low', 'high')).toBe('low');
    expect(normalizeResponsesReasoningEffort('xhigh')).toBe('xhigh');
  });
});

describe('buildResponsesRequestOptions', () => {
  it('passes the session id through the policy header builder', () => {
    const options = buildResponsesRequestOptions(undefined, CHATGPT_POLICY, {
      sessionId: 'session-1',
    });
    expect(options.headers).toEqual({ session_id: 'session-1' });
  });

  it('omits headers when the policy has no header builder', () => {
    expect(buildResponsesRequestOptions(undefined, OPENAI_POLICY).headers).toBeUndefined();
  });
});

describe('responses loop state', () => {
  it('round-trips loop items and session id through providerState', () => {
    const req = baseAgentRequest({ modelName: 'gpt-5.5' });
    const serialized = serializeResponsesTurnState(
      req,
      CHATGPT_POLICY,
      {
        sessionId: 'session-1',
        loopItems: [{ type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' }],
      },
      123
    );

    const parsed = parseResponsesLoopState(serialized, CHATGPT_POLICY);
    expect(parsed?.sessionId).toBe('session-1');
    expect(parsed?.loopItems).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
    ]);
  });

  it('rejects state from another provider or a durable mode', () => {
    const req = baseAgentRequest();
    const serialized = serializeResponsesTurnState(
      req,
      CHATGPT_POLICY,
      { sessionId: 's', loopItems: [] },
      undefined
    );

    expect(parseResponsesLoopState(serialized, OPENAI_POLICY)).toBeNull();
    expect(parseResponsesLoopState('{"provider":"chatgpt"}', CHATGPT_POLICY)).toBeNull();
    expect(parseResponsesLoopState(null, CHATGPT_POLICY)).toBeNull();
  });
});

describe('buildResponsesAgentTurnInput', () => {
  it('assembles stateless replay with encrypted reasoning and tool outputs', () => {
    const input = buildResponsesAgentTurnInput({
      policy: CHATGPT_POLICY,
      req: baseAgentRequest({
        prompt: undefined,
        history: [
          { id: 'u1', role: 'user', text: 'Find docs' },
          {
            id: 'a1',
            role: 'ai',
            text: 'I will search.',
            parts: [
              {
                type: 'thinking',
                text: 'Internal reasoning.',
                encrypted_content: 'enc_reasoning_1',
              } as unknown as NonNullable<AgentTurnRequest['history'][number]['parts']>[number],
              { type: 'text', text: 'I will search.' },
              {
                type: 'tool_call',
                toolCallId: 'call_1',
                name: 'search',
                args: { q: 'docs' },
              },
            ],
          },
        ],
        toolResults: [{ callId: 'call_1', name: 'search', result: '{"hits":[]}' }],
      }),
      previousResponseId: 'resp_ignored',
    });

    expect(input).toEqual([
      { role: 'user', content: 'Find docs' },
      { type: 'reasoning', encrypted_content: 'enc_reasoning_1' },
      { role: 'assistant', content: 'I will search.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: '{"q":"docs"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"hits":[]}',
      },
    ]);
  });

  it('injects the system prompt as the first item and loop items before current input', () => {
    const input = buildResponsesAgentTurnInput({
      policy: CHATGPT_POLICY,
      req: baseAgentRequest({
        systemPrompt: 'You are the MangoStudio agent.',
        prompt: undefined,
        history: [{ id: 'u1', role: 'user', text: 'Find docs' }],
        toolResults: [{ callId: 'call_1', name: 'search', result: '{"hits":[]}' }],
      }),
      loopItems: [
        { role: 'user', content: 'Find docs again' },
        { type: 'reasoning', encrypted_content: 'enc_1' },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"docs"}' },
      ],
    });

    expect(input).toEqual([
      { role: 'developer', content: 'You are the MangoStudio agent.' },
      { role: 'user', content: 'Find docs' },
      { role: 'user', content: 'Find docs again' },
      { type: 'reasoning', encrypted_content: 'enc_1' },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"docs"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"hits":[]}' },
    ]);
  });

  it('keeps the plain user role when the policy sends the system prompt as instructions', () => {
    const input = buildResponsesAgentTurnInput({
      policy: OPENAI_POLICY,
      req: baseAgentRequest({ systemPrompt: 'Be concise.', history: [] }),
    });

    expect(input).toEqual([{ role: 'user', content: 'Hello' }]);
  });
});
