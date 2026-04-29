import { afterEach, describe, expect, it, mock } from 'bun:test';
import { buildGeminiInteractionsReplay } from '../../../../src/services/providers/core/replay-builder';
import {
  computeSystemPromptHash,
  computeToolsetHash,
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
} from '../../../../src/services/providers/core/continuation-envelope';
import type { InteractionSSEEvent } from '../../../../src/services/providers/gemini/normalizers';
import type {
  AgentEvent,
  AgentTurnRequest,
  ToolDefinition,
} from '../../../../src/services/providers/types';

type CreateFn = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<AsyncIterable<InteractionSSEEvent>>;

const SEARCH_TOOL: ToolDefinition = {
  name: 'search',
  description: 'Search indexed content',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function streamOf<T>(events: T[]): AsyncIterable<T> {
  return (async function* () {
    await Promise.resolve();
    for (const event of events) yield event;
  })();
}

function completedInteraction(id = 'int_new'): InteractionSSEEvent[] {
  return [
    {
      event_type: 'interaction.complete',
      interaction: { id, usage: { total_input_tokens: 12 } },
    } as InteractionSSEEvent,
  ];
}

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u1',
    modelName: 'gemini-2.5-flash',
    history: [],
    prompt: 'Hello',
    systemPrompt: 'Be concise',
    toolDefinitions: [SEARCH_TOOL],
    generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    ...overrides,
  };
}

function buildEnvelope(req: AgentTurnRequest, cursor = 'int_prev'): string {
  return serializeContinuationEnvelope({
    schemaVersion: 1,
    provider: 'gemini',
    mode: 'interactions',
    modelName: req.modelName,
    systemPromptHash: computeSystemPromptHash(req.systemPrompt),
    toolsetHash: computeToolsetHash(req.toolDefinitions ?? []),
    cursor,
  });
}

async function collect(req: AgentTurnRequest, create: CreateFn): Promise<AgentEvent[]> {
  await mock.module('../../../../src/services/providers/gemini/secret', () => ({
    getResolvedGeminiApiKey: () => Promise.resolve('gemini-key'),
  }));
  await mock.module('../../../../src/services/providers/gemini/client', () => ({
    createGeminiClient: () => ({ interactions: { create } }),
  }));

  const { streamGeminiAgentTurn } =
    await import('../../../../src/services/providers/gemini/interactions-stream');
  const events: AgentEvent[] = [];
  for await (const event of streamGeminiAgentTurn(req)) events.push(event);
  return events;
}

afterEach(() => {
  mock.restore();
});

describe('streamGeminiAgentTurn', () => {
  it('replays history without previous_interaction_id and stores the turn', async () => {
    const signal = new AbortController().signal;
    const req = baseRequest({
      signal,
      history: [{ id: 'h1', role: 'user', text: 'Original prompt' }],
      prompt: 'New prompt',
    });
    let captured: Record<string, unknown> | undefined;
    let capturedOptions: { signal?: AbortSignal } | undefined;

    await collect(req, (params, options) => {
      captured = params;
      capturedOptions = options;
      return Promise.resolve(streamOf(completedInteraction()));
    });

    expect(captured?.previous_interaction_id).toBeUndefined();
    expect(captured?.input).toEqual([
      ...buildGeminiInteractionsReplay(req.history),
      { role: 'user', content: 'New prompt' },
    ]);
    expect(captured?.store).toBe(true);
    expect(capturedOptions?.signal).toBe(signal);
  });

  it('uses previous_interaction_id while still sending instructions and tools', async () => {
    const req = baseRequest({ providerState: buildEnvelope(baseRequest()) });
    let captured: Record<string, unknown> | undefined;

    await collect(req, (params) => {
      captured = params;
      return Promise.resolve(streamOf(completedInteraction()));
    });

    expect(captured?.previous_interaction_id).toBe('int_prev');
    expect(captured?.input).toBe('Hello');
    expect(captured?.system_instruction).toBe('Be concise');
    expect(captured?.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search indexed content',
        parameters: SEARCH_TOOL.parameters,
      },
    ]);
  });

  it('maps structured output to top-level response_format', async () => {
    const req = baseRequest({
      modelName: 'gemini-3-flash-preview',
      generationConfig: {
        thinkingEnabled: true,
        reasoningEffort: 'high',
        structuredOutput: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
    });
    let captured: Record<string, unknown> | undefined;

    await collect(req, (params) => {
      captured = params;
      return Promise.resolve(streamOf(completedInteraction()));
    });

    expect(captured?.response_mime_type).toBe('application/json');
    expect(captured?.response_format).toEqual({ type: 'object' });
    expect(captured?.generation_config).toEqual({
      thinking_level: 'high',
      thinking_summaries: 'auto',
    });
  });

  it('retries with replay when the continuation cursor expires on a user turn', async () => {
    let callCount = 0;
    const events = await collect(
      baseRequest({
        providerState: buildEnvelope(baseRequest()),
        history: [{ id: 'h1', role: 'user', text: 'Original prompt' }],
      }),
      (params) => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('previous interaction expired'));
        expect(params.previous_interaction_id).toBeUndefined();
        return Promise.resolve(streamOf(completedInteraction('int_retry')));
      }
    );

    expect(callCount).toBe(2);
    const degraded = events.find((event) => event.type === 'continuation_degraded');
    expect(degraded).toBeDefined();
    if (degraded?.type !== 'continuation_degraded') return;
    expect(degraded.from).toBe('interactions');
    expect(degraded.to).toBe('replay');
    expect(events.at(-1)?.type).toBe('turn_completed');
  });

  it('aborts safely when the continuation cursor expires during tool-result continuation', async () => {
    let callCount = 0;
    const events = await collect(
      baseRequest({
        providerState: buildEnvelope(baseRequest()),
        prompt: undefined,
        toolResults: [{ callId: 'call_1', name: 'search', result: '{"hits":[]}' }],
      }),
      () => {
        callCount++;
        return Promise.reject(new Error('previous interaction expired'));
      }
    );

    expect(callCount).toBe(1);
    const degraded = events.find((event) => event.type === 'continuation_degraded');
    expect(degraded).toBeDefined();
    if (degraded?.type !== 'continuation_degraded') return;
    expect(degraded.from).toBe('interactions');
    expect(degraded.to).toBe('tool_loop_aborted');
    expect(events.some((event) => event.type === 'turn_error')).toBe(true);
    expect(events.some((event) => event.type === 'turn_completed')).toBe(false);
  });

  it('emits a canonical interactions envelope on completion', async () => {
    const { processGeminiInteractionStream } =
      await import('../../../../src/services/providers/gemini/interactions-stream');
    const events: AgentEvent[] = [];

    for await (const event of processGeminiInteractionStream(
      streamOf(completedInteraction('int_done')),
      baseRequest(),
      computeToolsetHash([SEARCH_TOOL])
    )) {
      events.push(event);
    }

    const completed = events.find((event) => event.type === 'turn_completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'turn_completed') return;
    const envelope = parseContinuationEnvelope(completed.providerState);
    expect(envelope?.provider).toBe('gemini');
    expect(envelope?.mode).toBe('interactions');
    expect(envelope?.cursor).toBe('int_done');
  });
});
