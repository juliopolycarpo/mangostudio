import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildAnthropicCurrentInput,
  buildAnthropicLoopMessages,
  buildAnthropicProviderPrompt,
  buildAnthropicRequestMessages,
  parseAnthropicLoopState,
  serializeAnthropicTurnState,
} from '../../../../src/services/providers/anthropic/loop-state';
import { createAnthropicStreamAccumulator } from '../../../../src/services/providers/anthropic/stream-accumulator';
import { parseContinuationEnvelope } from '../../../../src/services/providers/core/continuation-envelope';
import type { AgentEvent, AgentTurnRequest } from '../../../../src/services/providers/types';

/** Casts a plain fake stream event to the SDK union for replay. */
function event(data: Record<string, unknown>): Anthropic.MessageStreamEvent {
  return data as unknown as Anthropic.MessageStreamEvent;
}

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'u1',
    modelName: 'claude-sonnet-4-5-20250929',
    history: [],
    prompt: 'Hello',
    generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createAnthropicStreamAccumulator
// ---------------------------------------------------------------------------

describe('createAnthropicStreamAccumulator', () => {
  it('maps a tool-use block lifecycle keyed by stream index', () => {
    const accumulator = createAnthropicStreamAccumulator();

    const events: AgentEvent[] = [
      ...accumulator.mapEvent(
        event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'search' },
        })
      ),
      ...accumulator.mapEvent(
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        })
      ),
      ...accumulator.mapEvent(
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"cats"}' },
        })
      ),
      ...accumulator.mapEvent(event({ type: 'content_block_stop', index: 0 })),
    ];

    expect(events).toEqual([
      { type: 'tool_call_started', callId: 'tu_1', name: 'search' },
      { type: 'tool_call_arguments_delta', callId: 'tu_1', delta: '{"q":' },
      { type: 'tool_call_arguments_delta', callId: 'tu_1', delta: '"cats"}' },
      { type: 'tool_call_completed', callId: 'tu_1', name: 'search', arguments: '{"q":"cats"}' },
    ]);
  });

  it('maps thinking and text deltas', () => {
    const accumulator = createAnthropicStreamAccumulator();

    const thinking = accumulator.mapEvent(
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      })
    );
    const text = accumulator.mapEvent(
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Answer.' },
      })
    );

    expect(thinking).toEqual([{ type: 'reasoning_delta', text: 'Let me think...' }]);
    expect(text).toEqual([{ type: 'assistant_text_delta', text: 'Answer.' }]);
  });

  it('ignores signature deltas and non-content events', () => {
    const accumulator = createAnthropicStreamAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'abc' },
        })
      )
    ).toEqual([]);
    expect(accumulator.mapEvent(event({ type: 'message_start', message: {} }))).toEqual([]);
  });

  it('ignores argument deltas and stops for unknown block indexes', () => {
    const accumulator = createAnthropicStreamAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          type: 'content_block_delta',
          index: 7,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        })
      )
    ).toEqual([]);
    expect(accumulator.mapEvent(event({ type: 'content_block_stop', index: 7 }))).toEqual([]);
  });

  it('synthesizes a call id when the tool_use block omits one', () => {
    const accumulator = createAnthropicStreamAccumulator();

    const started = accumulator.mapEvent(
      event({
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'tool_use', id: '', name: 'lookup' },
      })
    );

    expect(started).toHaveLength(1);
    const [startEvent] = started;
    expect(startEvent.type).toBe('tool_call_started');
    if (startEvent.type !== 'tool_call_started') return;
    expect(startEvent.callId).toMatch(/^tu_\d+_3$/);
    expect(startEvent.name).toBe('lookup');
  });
});

// ---------------------------------------------------------------------------
// loop-state helpers
// ---------------------------------------------------------------------------

describe('buildAnthropicProviderPrompt', () => {
  it('returns undefined when there is no prompt or attachment', () => {
    expect(buildAnthropicProviderPrompt(baseRequest({ prompt: undefined }))).toBeUndefined();
  });

  it('returns the prompt when present', () => {
    expect(buildAnthropicProviderPrompt(baseRequest({ prompt: 'Hi' }))).toBe('Hi');
  });
});

describe('buildAnthropicCurrentInput', () => {
  it('maps tool results into a single user tool_result message', () => {
    const req = baseRequest({
      prompt: undefined,
      toolResults: [{ callId: 'tu_1', name: 'search', result: '{"hits":[]}', isError: false }],
    });

    expect(buildAnthropicCurrentInput(req, undefined)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: '{"hits":[]}',
            is_error: false,
          },
        ],
      },
    ]);
  });

  it('falls back to the user prompt when no tool results', () => {
    expect(buildAnthropicCurrentInput(baseRequest(), 'Hello')).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('returns no input when neither tool results nor prompt are present', () => {
    expect(buildAnthropicCurrentInput(baseRequest({ prompt: undefined }), undefined)).toEqual([]);
  });
});

describe('buildAnthropicRequestMessages', () => {
  it('concatenates DB history, loop messages, and current input', () => {
    const req = baseRequest({ history: [{ id: 'h1', role: 'user', text: 'Prior' }] });
    const loopState = {
      provider: 'anthropic' as const,
      loopMessages: [{ role: 'assistant' as const, content: 'Earlier reply' }],
    };
    const currentInput: Anthropic.MessageParam[] = [{ role: 'user', content: 'Now' }];

    expect(buildAnthropicRequestMessages(req, loopState, currentInput)).toEqual([
      { role: 'user', content: 'Prior' },
      { role: 'assistant', content: 'Earlier reply' },
      { role: 'user', content: 'Now' },
    ]);
  });
});

describe('buildAnthropicLoopMessages', () => {
  it('appends current input and assistant reply to prior loop messages', () => {
    const currentInput: Anthropic.MessageParam[] = [{ role: 'user', content: 'Now' }];
    const assistantContent = [{ type: 'text', text: 'Reply' }] as Anthropic.ContentBlock[];

    expect(buildAnthropicLoopMessages(null, currentInput, assistantContent)).toEqual([
      { role: 'user', content: 'Now' },
      { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
    ]);
  });

  it('omits the assistant message when no content was produced', () => {
    const currentInput: Anthropic.MessageParam[] = [{ role: 'user', content: 'Now' }];
    expect(buildAnthropicLoopMessages(null, currentInput, [])).toEqual([
      { role: 'user', content: 'Now' },
    ]);
  });
});

describe('parseAnthropicLoopState', () => {
  it('parses valid anthropic loop state', () => {
    const state = JSON.stringify({ provider: 'anthropic', loopMessages: [] });
    expect(parseAnthropicLoopState(state)).toEqual({ provider: 'anthropic', loopMessages: [] });
  });

  it('rejects foreign or malformed state', () => {
    expect(parseAnthropicLoopState(JSON.stringify({ provider: 'openai' }))).toBeNull();
    expect(parseAnthropicLoopState('not json')).toBeNull();
    expect(parseAnthropicLoopState(null)).toBeNull();
  });
});

describe('serializeAnthropicTurnState', () => {
  it('embeds the continuation envelope and loop messages', () => {
    const req = baseRequest();
    const loopMessages: Anthropic.MessageParam[] = [{ role: 'assistant', content: 'Done' }];

    const serialized = serializeAnthropicTurnState(req, loopMessages, 128);
    const parsed = JSON.parse(serialized) as { loopMessages: unknown };

    const envelope = parseContinuationEnvelope(serialized);
    expect(envelope?.provider).toBe('anthropic');
    expect(envelope?.mode).toBe('stateless-loop');
    expect(envelope?.context?.providerReportedInputTokens).toBe(128);
    expect(parsed.loopMessages).toEqual([{ role: 'assistant', content: 'Done' }]);
  });
});
