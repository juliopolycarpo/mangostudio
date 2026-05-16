import { describe, expect, it, mock } from 'bun:test';
import { streamAnthropicAgentTurn } from '../../../../src/services/providers/anthropic/stream';
import { streamAgentTurnWithResponsesAPI } from '../../../../src/services/providers/openai/responses-stream';
import { streamOAICompatAgentTurn } from '../../../../src/services/providers/openai-compatible/chat-completions-stream';
import type {
  AgentEvent,
  AgentTurnRequest,
  StructuredOutputConfig,
} from '../../../../src/services/providers/types';

const SAMPLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

const STRUCTURED: StructuredOutputConfig = {
  name: 'AnswerPayload',
  schema: SAMPLE_SCHEMA,
};

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u1',
    modelName: 'test-model',
    history: [],
    prompt: 'Hello',
    generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    ...overrides,
  };
}

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    await Promise.resolve();
    for (const it of items) yield it;
  })();
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

describe('streamAgentTurnWithResponsesAPI — structured output', () => {
  const COMPLETED = {
    type: 'response.completed',
    response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 5 } },
  };

  function mockResponsesClient(capture: { params?: Record<string, unknown> }) {
    return {
      responses: {
        create: (params: Record<string, unknown>) => {
          capture.params = params;
          return Promise.resolve(asyncIter([COMPLETED]));
        },
      },
    } as unknown as Parameters<typeof streamAgentTurnWithResponsesAPI>[0];
  }

  it('maps structuredOutput to text.format with strict defaulting to true', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await drain(
      streamAgentTurnWithResponsesAPI(
        mockResponsesClient(capture),
        baseRequest({
          generationConfig: {
            thinkingEnabled: false,
            reasoningEffort: 'medium',
            structuredOutput: STRUCTURED,
          },
        })
      )
    );

    expect(capture.params?.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'AnswerPayload',
        schema: SAMPLE_SCHEMA,
        strict: true,
      },
    });
  });

  it('honors explicit strict=false', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await drain(
      streamAgentTurnWithResponsesAPI(
        mockResponsesClient(capture),
        baseRequest({
          generationConfig: {
            thinkingEnabled: false,
            reasoningEffort: 'medium',
            structuredOutput: { ...STRUCTURED, strict: false },
          },
        })
      )
    );

    const format = (capture.params?.text as { format?: { strict?: boolean } })?.format;
    expect(format?.strict).toBe(false);
  });

  it('omits text format when structuredOutput is absent', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await drain(streamAgentTurnWithResponsesAPI(mockResponsesClient(capture), baseRequest()));
    expect(capture.params?.text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions
// ---------------------------------------------------------------------------

describe('streamOAICompatAgentTurn — structured output', () => {
  function mockCompatClient(capture: { params?: Record<string, unknown> }) {
    return {
      chat: {
        completions: {
          create: (params: Record<string, unknown>) => {
            capture.params = params;
            return Promise.resolve(
              asyncIter([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
            );
          },
        },
      },
    } as unknown as Parameters<typeof streamOAICompatAgentTurn>[0];
  }

  it('maps structuredOutput to response_format json_schema', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await drain(
      streamOAICompatAgentTurn(
        mockCompatClient(capture),
        baseRequest({
          generationConfig: {
            thinkingEnabled: false,
            reasoningEffort: 'medium',
            structuredOutput: STRUCTURED,
          },
        })
      )
    );

    expect(capture.params?.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'AnswerPayload',
        schema: SAMPLE_SCHEMA,
        strict: true,
      },
    });
  });

  it('omits response_format when structuredOutput is absent', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await drain(streamOAICompatAgentTurn(mockCompatClient(capture), baseRequest()));
    expect(capture.params?.response_format).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic (unsupported — must warn, never silently pass)
// ---------------------------------------------------------------------------

describe('streamAnthropicAgentTurn — structured output degrade', () => {
  function mockAnthropicClient() {
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        await Promise.resolve();
        yield { type: 'message_stop' };
      },
      finalMessage: () =>
        Promise.resolve({
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
    };
    return {
      messages: {
        stream: () => stream,
      },
    } as unknown as Parameters<typeof streamAnthropicAgentTurn>[0];
  }

  it('logs a warning and continues when structuredOutput is requested', async () => {
    const warn = mock((..._args: unknown[]) => undefined);
    const original = console.warn;
    console.warn = warn;
    try {
      const events = await drain(
        streamAnthropicAgentTurn(
          mockAnthropicClient(),
          baseRequest({
            modelName: 'claude-sonnet-4-5',
            generationConfig: {
              thinkingEnabled: false,
              reasoningEffort: 'medium',
              structuredOutput: STRUCTURED,
            },
          })
        )
      );

      const joined = warn.mock.calls
        .flat()
        .filter((a): a is string => typeof a === 'string')
        .join(' ');
      expect(joined).toContain('[anthropic][structured-output]');
      expect(joined).toContain('claude-sonnet-4-5');
      expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    } finally {
      console.warn = original;
    }
  });
});
