import { describe, expect, it } from 'bun:test';
import { buildGeminiInteractionsReplay } from '../../../../src/services/providers/core/replay-builder';
import {
  computeSystemPromptHash,
  computeToolsetHash,
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
} from '../../../../src/services/providers/core/continuation-envelope';
import { expectTurnCompletedEnvelope } from '../../../support/providers/contract-assertions';
import { streamGeminiAgentTurn } from '../../../../src/services/providers/gemini/interactions-stream';
import { processGeminiInteractionStream } from '../../../../src/services/providers/gemini/interactions-stream';
import {
  createFakeGeminiInteractionsClient,
  completedInteractionEvent,
  textDeltaEvent,
  functionCallStartEvent,
  functionCallDeltaEvent,
  functionCallStopEvent,
  thoughtSummaryEvent,
  chainEvents,
} from '../../../support/providers/fake-gemini-interactions';
import { collectAgentEvents } from '../../../support/providers/agent-event-collector';
import type {
  AgentEvent,
  AgentTurnRequest,
  ProviderRuntimeAttachment,
  ToolDefinition,
} from '../../../../src/services/providers/types';

const SEARCH_TOOL: ToolDefinition = {
  name: 'search',
  description: 'Search indexed content',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

const ATTACHMENT_CAPABILITIES = {
  text: true,
  image: false,
  streaming: true,
  fileAttachments: true,
  imageInput: true,
  pdfInput: true,
  textFileInput: true,
};

function runtimeAttachment(
  overrides: Partial<ProviderRuntimeAttachment> = {}
): ProviderRuntimeAttachment {
  return {
    id: 'attachment-a',
    originalName: 'attachment.png',
    mimeType: 'image/png',
    sizeBytes: 2,
    kind: 'image',
    bytes: new Uint8Array([1, 2]),
    ...overrides,
  };
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

function buildOpenAIEnvelope(cursor = 'resp_abc123'): string {
  return serializeContinuationEnvelope({
    schemaVersion: 1,
    provider: 'openai',
    mode: 'responses',
    modelName: 'gpt-4o',
    systemPromptHash: computeSystemPromptHash('Be concise'),
    toolsetHash: computeToolsetHash([SEARCH_TOOL]),
    cursor,
  });
}

// ---------------------------------------------------------------------------
// streamGeminiAgentTurn — request shape
// ---------------------------------------------------------------------------

describe('streamGeminiAgentTurn — request shape', () => {
  it('first request replays history without previous_interaction_id', async () => {
    const signal = new AbortController().signal;
    const req = baseRequest({
      signal,
      history: [{ id: 'h1', role: 'user', text: 'Original prompt' }],
      prompt: 'New prompt',
    });
    let captured: Record<string, unknown> | undefined;
    let capturedOptions: { signal?: AbortSignal } | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params, options) => {
      captured = params;
      capturedOptions = options;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBeUndefined();
    expect(captured?.input).toEqual([
      ...buildGeminiInteractionsReplay(req.history),
      { role: 'user', content: 'New prompt' },
    ]);
    expect(captured?.store).toBe(true);
    expect(capturedOptions?.signal).toBe(signal);
  });

  it('follow-up with valid cursor sends previous_interaction_id and only new input', async () => {
    const req = baseRequest({ providerState: buildEnvelope(baseRequest()) });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

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

  it('maps current-turn attachments into Interactions input content', async () => {
    const req = baseRequest({
      prompt: 'Describe these files.',
      modelCapabilities: ATTACHMENT_CAPABILITIES,
      attachments: [
        runtimeAttachment({
          id: 'image-a',
          originalName: 'diagram.png',
          mimeType: 'image/png',
          kind: 'image',
          sizeBytes: 2,
          bytes: new Uint8Array([1, 2]),
        }),
        runtimeAttachment({
          id: 'pdf-a',
          originalName: 'report.pdf',
          mimeType: 'application/pdf',
          kind: 'pdf',
          sizeBytes: 2,
          bytes: new Uint8Array([3, 4]),
        }),
        runtimeAttachment({
          id: 'text-a',
          originalName: 'notes.txt',
          mimeType: 'text/plain',
          kind: 'text',
          sizeBytes: 5,
          bytes: new Uint8Array([104, 101, 108, 108, 111]),
        }),
        runtimeAttachment({
          id: 'data-a',
          originalName: 'archive.bin',
          mimeType: 'application/octet-stream',
          kind: 'data',
          sizeBytes: 1,
          bytes: new Uint8Array([9]),
        }),
      ],
    });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.input).toEqual([
      { type: 'text', text: 'Describe these files.' },
      { type: 'image', data: 'AQI=', mime_type: 'image/png' },
      { type: 'document', data: 'AwQ=', mime_type: 'application/pdf', name: 'report.pdf' },
      { type: 'document', data: 'aGVsbG8=', mime_type: 'text/plain', name: 'notes.txt' },
      {
        type: 'text',
        text: '[Attachment "archive.bin" (application/octet-stream, 1 bytes) was not sent because this attachment type is not supported.]',
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

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.response_mime_type).toBe('application/json');
    expect(captured?.response_format).toEqual({ type: 'object' });
    expect(captured?.generation_config).toEqual({
      thinking_level: 'high',
      thinking_summaries: 'auto',
    });
  });

  it('sends tool results as function_result array on continuation', async () => {
    const req = baseRequest({
      prompt: undefined,
      providerState: buildEnvelope(baseRequest()),
      modelCapabilities: ATTACHMENT_CAPABILITIES,
      attachments: [runtimeAttachment()],
      toolResults: [{ callId: 'call_1', name: 'search', result: '{"hits":[]}' }],
    });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBe('int_prev');
    const input = captured?.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      type: 'function_result',
      call_id: 'call_1',
      name: 'search',
      result: { output: '{"hits":[]}' },
      is_error: false,
    });
  });
});

// ---------------------------------------------------------------------------
// streamGeminiAgentTurn — continuation matrix
// ---------------------------------------------------------------------------

describe('streamGeminiAgentTurn — continuation matrix', () => {
  it('first turn replays full history', async () => {
    const req = baseRequest({
      history: [{ id: 'h1', role: 'user', text: 'Prior' }],
      prompt: 'Next',
    });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBeUndefined();
    const input = captured?.input as Array<Record<string, unknown>>;
    expect(input.length).toBeGreaterThan(1);
    expect(input.at(-1)).toEqual({ role: 'user', content: 'Next' });
  });

  it('valid cursor chains with previous_interaction_id', async () => {
    const req = baseRequest({ providerState: buildEnvelope(baseRequest()) });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent());
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBe('int_prev');
  });

  it('provider switch ignores foreign cursor and replays', async () => {
    const req = baseRequest({ providerState: buildOpenAIEnvelope() });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent('int_after_switch'));
    });

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBeUndefined();
    const completed = events.find((e) => e.type === 'turn_completed');
    expect(completed?.type).toBe('turn_completed');
    if (completed?.type !== 'turn_completed') return;
    const envelope = parseContinuationEnvelope(completed.providerState);
    expect(envelope?.cursor).toBe('int_after_switch');
  });

  it('cursor expired on user turn retries with full replay', async () => {
    let callCount = 0;
    const req = baseRequest({
      providerState: buildEnvelope(baseRequest()),
      history: [{ id: 'h1', role: 'user', text: 'Original prompt' }],
    });

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('previous interaction expired'));
      }
      expect(params.previous_interaction_id).toBeUndefined();
      return Promise.resolve(completedInteractionEvent('int_retry'));
    });

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(callCount).toBe(2);
    const degraded = events.find((e) => e.type === 'continuation_degraded');
    expect(degraded).toBeDefined();
    if (degraded?.type !== 'continuation_degraded') return;
    expect(degraded.from).toBe('interactions');
    expect(degraded.to).toBe('replay');
    expect(degraded.reasonCode).toBe('cursor_expired');
    expect(events.at(-1)?.type).toBe('turn_completed');
  });

  it('tool-result cursor expired aborts until turn trace exists', async () => {
    let callCount = 0;
    const req = baseRequest({
      providerState: buildEnvelope(baseRequest()),
      prompt: undefined,
      toolResults: [{ callId: 'call_1', name: 'search', result: '{"hits":[]}' }],
    });

    const fakeClient = createFakeGeminiInteractionsClient(() => {
      callCount++;
      return Promise.reject(new Error('previous interaction expired'));
    });

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(callCount).toBe(1);
    const degraded = events.find((e) => e.type === 'continuation_degraded');
    expect(degraded).toBeDefined();
    if (degraded?.type !== 'continuation_degraded') return;
    expect(degraded.from).toBe('interactions');
    expect(degraded.to).toBe('tool_loop_aborted');
    expect(degraded.reasonCode).toBe('tool_result_cursor_loss');
    expect(events.some((e) => e.type === 'turn_error')).toBe(true);
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streamGeminiAgentTurn — provider switch replay then recovery
// ---------------------------------------------------------------------------

describe('streamGeminiAgentTurn — provider switch replay then recovery', () => {
  it('first Gemini turn after OpenAI switch replays and mints new cursor', async () => {
    const req = baseRequest({
      providerState: buildOpenAIEnvelope('resp_old'),
      history: [{ id: 'h1', role: 'user', text: 'Hello' }],
      prompt: 'Continue',
    });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent('int_first_gemini'));
    });

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBeUndefined();
    const completed = events.find((e) => e.type === 'turn_completed');
    expect(completed?.type).toBe('turn_completed');
    if (completed?.type !== 'turn_completed') return;
    const envelope = parseContinuationEnvelope(completed.providerState);
    expect(envelope?.provider).toBe('gemini');
    expect(envelope?.cursor).toBe('int_first_gemini');
  });

  it('second Gemini turn uses previous_interaction_id from first Gemini cursor', async () => {
    const firstEnvelope = buildEnvelope(baseRequest(), 'int_first_gemini');
    const req = baseRequest({
      providerState: firstEnvelope,
      prompt: 'Next',
    });
    let captured: Record<string, unknown> | undefined;

    const fakeClient = createFakeGeminiInteractionsClient((params) => {
      captured = params;
      return Promise.resolve(completedInteractionEvent('int_second_gemini'));
    });

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    expect(captured?.previous_interaction_id).toBe('int_first_gemini');
    const completed = events.find((e) => e.type === 'turn_completed');
    expect(completed?.type).toBe('turn_completed');
    if (completed?.type !== 'turn_completed') return;
    const envelope = parseContinuationEnvelope(completed.providerState);
    expect(envelope?.cursor).toBe('int_second_gemini');
  });
});

// ---------------------------------------------------------------------------
// streamGeminiAgentTurn — event emission
// ---------------------------------------------------------------------------

describe('streamGeminiAgentTurn — event emission', () => {
  it('emits text deltas and a canonical envelope', async () => {
    const req = baseRequest();
    const fakeClient = createFakeGeminiInteractionsClient(() =>
      Promise.resolve(
        chainEvents(
          textDeltaEvent('Hello'),
          textDeltaEvent(' world'),
          completedInteractionEvent('int_done', 42)
        )
      )
    );

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    const textEvents = events.filter((e) => e.type === 'assistant_text_delta');
    expect(textEvents.map((e) => (e as { text: string }).text).join('')).toBe('Hello world');

    const completed = events.find((e) => e.type === 'turn_completed');
    expect(completed?.type).toBe('turn_completed');
    if (completed?.type !== 'turn_completed') return;
    const envelope = parseContinuationEnvelope(completed.providerState);
    expect(envelope?.cursor).toBe('int_done');
    expect(envelope?.context?.providerReportedInputTokens).toBe(42);
  });

  it('emits reasoning deltas for thought_summary events', async () => {
    const req = baseRequest({
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'medium' },
    });
    const fakeClient = createFakeGeminiInteractionsClient(() =>
      Promise.resolve(
        chainEvents(
          thoughtSummaryEvent('Thinking...'),
          textDeltaEvent('Answer'),
          completedInteractionEvent('int_reasoning')
        )
      )
    );

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    const reasoning = events.find((e) => e.type === 'reasoning_delta');
    expect(reasoning).toBeDefined();
    if (reasoning?.type !== 'reasoning_delta') return;
    expect(reasoning.text).toBe('Thinking...');
  });

  it('emits tool_call_started, arguments_delta, and tool_call_completed', async () => {
    const req = baseRequest();
    const fakeClient = createFakeGeminiInteractionsClient(() =>
      Promise.resolve(
        chainEvents(
          functionCallStartEvent(0, 'fc_1', 'search'),
          functionCallDeltaEvent(0, 'fc_1', 'search', { query: 'cats' }),
          functionCallStopEvent(0),
          completedInteractionEvent('int_tools')
        )
      )
    );

    const events = await collectAgentEvents(streamGeminiAgentTurn(req, fakeClient as never));

    const started = events.find((e) => e.type === 'tool_call_started');
    expect(started).toBeDefined();
    if (started?.type !== 'tool_call_started') return;
    expect(started.callId).toBe('fc_1');
    expect(started.name).toBe('search');

    const argsDelta = events.find((e) => e.type === 'tool_call_arguments_delta');
    expect(argsDelta).toBeDefined();

    const completed = events.find((e) => e.type === 'tool_call_completed');
    expect(completed).toBeDefined();
    if (completed?.type !== 'tool_call_completed') return;
    expect(completed.callId).toBe('fc_1');
    expect(completed.name).toBe('search');
  });
});

// ---------------------------------------------------------------------------
// processGeminiInteractionStream — envelope contract
// ---------------------------------------------------------------------------

describe('processGeminiInteractionStream', () => {
  it('emits a canonical interactions envelope on completion', async () => {
    const events: AgentEvent[] = [];

    for await (const event of processGeminiInteractionStream(
      completedInteractionEvent('int_done'),
      baseRequest()
    )) {
      events.push(event);
    }

    expectTurnCompletedEnvelope(events, {
      provider: 'gemini',
      mode: 'interactions',
      cursor: 'int_done',
    });
  });
});
