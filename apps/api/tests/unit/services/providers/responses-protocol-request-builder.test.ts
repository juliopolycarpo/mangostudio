import { describe, expect, it } from 'bun:test';
import {
  buildResponsesAgentTurnInput,
  buildResponsesCreateParams,
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
  include: ['reasoning.encrypted_content'],
  allowMaxOutputTokens: false,
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
});
