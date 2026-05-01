import { describe, expect, it } from 'bun:test';
import { APIError } from 'openai';
import { streamAgentTurnWithResponsesAPI } from '../../../../src/services/providers/openai/responses-stream';
import {
  isStrictCompatible,
  toolDefsToResponsesAPI,
} from '../../../../src/services/providers/core/tool-mapper';
import {
  serializeContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
} from '../../../../src/services/providers/core/continuation-envelope';
import {
  expectTurnCompletedEnvelope,
  expectContinuationDegraded,
} from '../../../../tests/support/providers/contract-assertions';
import type { AgentEvent, AgentTurnRequest } from '../../../../src/services/providers/types';

type CreateFn = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<AsyncIterable<unknown>>;

function streamOf(events: Array<Record<string, unknown>>): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve();
    for (const ev of events) yield ev;
  })();
}

function mockClient(create: CreateFn): Parameters<typeof streamAgentTurnWithResponsesAPI>[0] {
  return { responses: { create } } as unknown as Parameters<
    typeof streamAgentTurnWithResponsesAPI
  >[0];
}

async function collect(req: AgentTurnRequest, create: CreateFn): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of streamAgentTurnWithResponsesAPI(mockClient(create), req)) {
    events.push(ev);
  }
  return events;
}

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u1',
    modelName: 'gpt-4o',
    history: [],
    prompt: 'Hello',
    generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    ...overrides,
  };
}

function buildEnvelope(cursor: string, modelName = 'gpt-4o'): string {
  return serializeContinuationEnvelope({
    schemaVersion: 1,
    provider: 'openai',
    mode: 'responses',
    modelName,
    systemPromptHash: computeSystemPromptHash(undefined),
    toolsetHash: computeToolsetHash([]),
    cursor,
  });
}

const COMPLETED_EVENT = (id = 'resp_new', inputTokens = 42) => ({
  type: 'response.completed',
  response: {
    id,
    usage: { input_tokens: inputTokens, output_tokens: 10 },
  },
});

// ---------------------------------------------------------------------------
// isStrictCompatible
// ---------------------------------------------------------------------------

describe('isStrictCompatible', () => {
  it('accepts a schema with all properties required and no additionalProperties', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      })
    ).toBe(true);
  });

  it('rejects when a property is missing from required', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a'],
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('rejects when additionalProperties is not false', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      })
    ).toBe(false);
  });

  it('rejects schemas using oneOf/anyOf/allOf/$ref anywhere in the tree', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
        required: ['a'],
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('accepts an empty object schema (no properties)', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      })
    ).toBe(true);
  });

  it('rejects non-object root schemas', () => {
    expect(isStrictCompatible({ type: 'string' })).toBe(false);
    expect(isStrictCompatible(null)).toBe(false);
    expect(isStrictCompatible(undefined)).toBe(false);
  });
});

describe('toolDefsToResponsesAPI strict flag', () => {
  it('sets strict=true for compatible schemas, strict=false otherwise', () => {
    const mapped = toolDefsToResponsesAPI([
      {
        name: 'strict_ok',
        description: 'ok',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'loose',
        description: 'loose',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: [],
        },
      },
    ]);
    expect(mapped[0].strict).toBe(true);
    expect(mapped[1].strict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streamAgentTurnWithResponsesAPI request shape
// ---------------------------------------------------------------------------

describe('streamAgentTurnWithResponsesAPI — request shape', () => {
  it('first request uses full replay and no previous_response_id', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        history: [
          { id: 'h1', role: 'user', text: 'prior question' },
          { id: 'h2', role: 'ai', text: 'prior answer' },
        ],
        prompt: 'follow up',
      }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    expect(captured).toBeDefined();
    expect(captured?.previous_response_id).toBeUndefined();
    expect(captured?.context_management).toBeUndefined();
    const input = captured?.input as Array<Record<string, unknown>>;
    expect(input.length).toBeGreaterThan(1);
    expect(input[input.length - 1]).toEqual({ role: 'user', content: 'follow up' });
  });

  it('follow-up with valid cursor sends previous_response_id and only the new message', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        providerState: buildEnvelope('resp_prev_123'),
        prompt: 'next',
      }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    expect(captured?.previous_response_id).toBe('resp_prev_123');
    const input = captured?.input as Array<Record<string, unknown>>;
    expect(input).toEqual([{ role: 'user', content: 'next' }]);
  });

  it('adds context_management compaction only when chaining with previous_response_id', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({ providerState: buildEnvelope('resp_prev_abc'), prompt: 'again' }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    const cm = captured?.context_management as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(cm)).toBe(true);
    expect(cm?.[0]?.type).toBe('compaction');
    expect(typeof cm?.[0]?.compact_threshold).toBe('number');
    expect(cm?.[0]?.compact_threshold as number).toBeGreaterThan(0);
  });

  it('uses the configured provider compaction threshold when chaining responses', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        providerState: buildEnvelope('resp_prev_threshold'),
        prompt: 'again',
        generationConfig: {
          thinkingEnabled: false,
          reasoningEffort: 'medium',
          providerCompactionThreshold: 0.9,
        },
      }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    const cm = captured?.context_management as Array<Record<string, unknown>> | undefined;
    expect(cm?.[0]?.compact_threshold).toBe(Math.floor(128_000 * 0.9));
  });

  it('passes AbortSignal to responses.create', async () => {
    const ac = new AbortController();
    let capturedOptions: { signal?: AbortSignal } | undefined;
    await collect(baseRequest({ prompt: 'test', signal: ac.signal }), (_params, opts) => {
      capturedOptions = opts;
      return Promise.resolve(streamOf([COMPLETED_EVENT()]));
    });

    expect(capturedOptions?.signal).toBe(ac.signal);
  });

  it('includes store: true on first, chained, and replay retry requests', async () => {
    // First request
    let captured1: Record<string, unknown> | undefined;
    await collect(baseRequest(), (params) => {
      captured1 = params;
      return Promise.resolve(streamOf([COMPLETED_EVENT()]));
    });
    expect(captured1?.store).toBe(true);

    // Chained request
    let captured2: Record<string, unknown> | undefined;
    await collect(
      baseRequest({ providerState: buildEnvelope('resp_prev'), prompt: 'next' }),
      (params) => {
        captured2 = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );
    expect(captured2?.store).toBe(true);

    // Replay retry (cursor expired → fallback)
    let callCount = 0;
    let captured3: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        providerState: buildEnvelope('resp_stale'),
        prompt: 'retry',
        history: [{ id: 'h1', role: 'user', text: 'original' }],
      }),
      (params) => {
        callCount++;
        captured3 = params;
        if (callCount === 1) return Promise.reject(cursorError());
        return Promise.resolve(streamOf([COMPLETED_EVENT('resp_new')]));
      }
    );
    expect(captured3?.store).toBe(true);
  });

  it('keeps instructions on chained requests', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        systemPrompt: 'You are a helpful assistant.',
        providerState: buildEnvelope('resp_prev'),
        prompt: 'hello',
      }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    expect(captured?.instructions).toBe('You are a helpful assistant.');
  });

  it('keeps tools on chained requests', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        providerState: buildEnvelope('resp_prev'),
        prompt: 'search for something',
        toolDefinitions: [
          {
            name: 'search',
            description: 'Search the web',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
              additionalProperties: false,
            },
          },
        ],
      }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    const tools = captured?.tools as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools?.[0]?.name).toBe('search');
  });

  it('omits context_management when enableProviderCompaction disables compaction', async () => {
    let captured: Record<string, unknown> | undefined;
    await collect(
      baseRequest({
        providerState: buildEnvelope('resp_prev'),
        prompt: 'again',
        generationConfig: {
          thinkingEnabled: false,
          reasoningEffort: 'medium',
          enableProviderCompaction: false,
        },
      }),
      (params) => {
        captured = params;
        return Promise.resolve(streamOf([COMPLETED_EVENT()]));
      }
    );

    expect(captured?.context_management).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cursor expiry handling
// ---------------------------------------------------------------------------

function cursorError(): Error {
  return new APIError(
    404,
    { error: { message: 'previous_response_id not found' } },
    'Not Found',
    new Headers({ 'content-type': 'application/json' })
  );
}

describe('streamAgentTurnWithResponsesAPI — cursor expiry', () => {
  it('degrades to replay when cursor is expired and no tool results are pending', async () => {
    let callCount = 0;
    const events = await collect(
      baseRequest({
        providerState: buildEnvelope('resp_stale'),
        prompt: 'ask again',
        history: [{ id: 'h1', role: 'user', text: 'original' }],
      }),
      (params) => {
        callCount++;
        if (callCount === 1) return Promise.reject(cursorError());
        // Second call (after fallback) must NOT include previous_response_id.
        expect(params.previous_response_id).toBeUndefined();
        return Promise.resolve(streamOf([COMPLETED_EVENT('resp_new')]));
      }
    );

    expect(callCount).toBe(2);
    expectContinuationDegraded(events, {
      from: 'responses',
      to: 'replay',
      reasonCode: 'cursor_expired',
    });
    expect(events.at(-1)?.type).toBe('turn_completed');
  });

  it('aborts without retry when cursor is expired during tool-result continuation', async () => {
    let callCount = 0;
    const events = await collect(
      baseRequest({
        providerState: buildEnvelope('resp_stale'),
        prompt: undefined,
        toolResults: [{ callId: 'call_1', name: 'search', result: '{"hits":[]}' }],
      }),
      () => {
        callCount++;
        return Promise.reject(cursorError());
      }
    );

    expect(callCount).toBe(1);
    expectContinuationDegraded(events, {
      from: 'responses',
      to: 'tool_loop_aborted',
      reasonCode: 'tool_result_cursor_loss',
    });
    expect(events.some((e) => e.type === 'turn_error')).toBe(true);
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage reporting
// ---------------------------------------------------------------------------

describe('streamAgentTurnWithResponsesAPI — usage reporting', () => {
  it('populates providerReportedInputTokens from completed usage', async () => {
    const events = await collect(baseRequest({ providerState: buildEnvelope('resp_prev') }), () =>
      Promise.resolve(streamOf([COMPLETED_EVENT('resp_new', 321)]))
    );

    expectTurnCompletedEnvelope(events, {
      provider: 'openai',
      mode: 'responses',
      cursor: 'resp_new',
      providerReportedInputTokens: 321,
    });
  });

  it('skips providerReportedInputTokens when usage reports zero (compaction zero-usage bug)', async () => {
    const events = await collect(baseRequest({ providerState: buildEnvelope('resp_prev') }), () =>
      Promise.resolve(streamOf([COMPLETED_EVENT('resp_new', 0)]))
    );

    const envelope = expectTurnCompletedEnvelope(events, {
      provider: 'openai',
      mode: 'responses',
      cursor: 'resp_new',
    });
    expect(envelope?.context?.providerReportedInputTokens).toBeUndefined();
  });
});
