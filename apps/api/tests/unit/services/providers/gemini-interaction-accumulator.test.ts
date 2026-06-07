import { describe, expect, it } from 'bun:test';
import { createGeminiInteractionAccumulator } from '../../../../src/services/providers/gemini/interaction-accumulator';
import type { InteractionSSEEvent } from '../../../../src/services/providers/gemini/normalizers';
import type { AgentEvent } from '../../../../src/services/providers/types';

/** Casts a plain fake SSE event to the SDK union for replay. */
function event(data: Record<string, unknown>): InteractionSSEEvent {
  return data as unknown as InteractionSSEEvent;
}

describe('createGeminiInteractionAccumulator', () => {
  it('maps a function call whose name is known at content.start', () => {
    const accumulator = createGeminiInteractionAccumulator();

    const events: AgentEvent[] = [
      ...accumulator.mapEvent(
        event({
          event_type: 'content.start',
          index: 0,
          content: { type: 'function_call', id: 'fc_1', name: 'search' },
        })
      ),
      ...accumulator.mapEvent(
        event({
          event_type: 'content.delta',
          index: 0,
          delta: {
            type: 'function_call',
            id: 'fc_1',
            name: 'search',
            arguments: { query: 'cats' },
          },
        })
      ),
      ...accumulator.mapEvent(event({ event_type: 'content.stop', index: 0 })),
    ];

    expect(events).toEqual([
      { type: 'tool_call_started', callId: 'fc_1', name: 'search' },
      { type: 'tool_call_arguments_delta', callId: 'fc_1', delta: '{"query":"cats"}' },
      {
        type: 'tool_call_completed',
        callId: 'fc_1',
        name: 'search',
        arguments: '{"query":"cats"}',
      },
    ]);
  });

  it('starts a function call lazily when the name only arrives in a delta', () => {
    const accumulator = createGeminiInteractionAccumulator();

    // No name at start: the call is tracked but not yet started.
    expect(
      accumulator.mapEvent(
        event({
          event_type: 'content.start',
          index: 0,
          content: { type: 'function_call', id: 'fc_2', name: '' },
        })
      )
    ).toEqual([]);

    const events = accumulator.mapEvent(
      event({
        event_type: 'content.delta',
        index: 0,
        delta: { type: 'function_call', id: 'fc_2', name: 'lookup', arguments: { q: 1 } },
      })
    );

    expect(events).toEqual([
      { type: 'tool_call_started', callId: 'fc_2', name: 'lookup' },
      { type: 'tool_call_arguments_delta', callId: 'fc_2', delta: '{"q":1}' },
    ]);
  });

  it('maps text and thought-summary deltas, ignoring thought signatures', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'content.delta',
          delta: { type: 'thought_summary', content: { text: 'Thinking.' } },
        })
      )
    ).toEqual([{ type: 'reasoning_delta', text: 'Thinking.' }]);

    expect(
      accumulator.mapEvent(
        event({ event_type: 'content.delta', delta: { type: 'text', text: 'Answer.' } })
      )
    ).toEqual([{ type: 'assistant_text_delta', text: 'Answer.' }]);

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'content.delta',
          delta: { type: 'thought_signature', signature: 'sig' },
        })
      )
    ).toEqual([]);
  });

  it('captures interaction id and usage on completion', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'interaction.complete',
          interaction: {
            id: 'int_done',
            usage: { total_input_tokens: 99, total_cached_tokens: 33 },
          },
        })
      )
    ).toEqual([]);

    expect(accumulator.interactionId).toBe('int_done');
    expect(accumulator.providerReportedInputTokens).toBe(99);
  });

  it('captures interaction id from interaction.start', () => {
    const accumulator = createGeminiInteractionAccumulator();

    accumulator.mapEvent(
      event({ event_type: 'interaction.start', interaction: { id: 'int_started' } })
    );

    expect(accumulator.interactionId).toBe('int_started');
    expect(accumulator.providerReportedInputTokens).toBeUndefined();
  });

  it('skips usage when completion reports zero input tokens', () => {
    const accumulator = createGeminiInteractionAccumulator();

    accumulator.mapEvent(
      event({
        event_type: 'interaction.complete',
        interaction: { id: 'int_zero', usage: { total_input_tokens: 0 } },
      })
    );

    expect(accumulator.providerReportedInputTokens).toBeUndefined();
  });

  it('ignores deltas for unknown call indexes', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'content.delta',
          index: 5,
          delta: { type: 'function_call', id: 'fc_x', name: 'x', arguments: {} },
        })
      )
    ).toEqual([]);
    expect(accumulator.mapEvent(event({ event_type: 'content.stop', index: 5 }))).toEqual([]);
  });
});
