import { describe, expect, it } from 'bun:test';
import { createGeminiInteractionAccumulator } from '../../../../src/services/providers/gemini/interaction-accumulator';
import type { InteractionSSEEvent } from '../../../../src/services/providers/gemini/normalizers';
import type { AgentEvent } from '../../../../src/services/providers/types';

/** Casts a plain fake SSE event to the SDK union for replay. */
function event(data: Record<string, unknown>): InteractionSSEEvent {
  return data as unknown as InteractionSSEEvent;
}

describe('createGeminiInteractionAccumulator', () => {
  it('reassembles arguments streamed as JSON fragments across step deltas', () => {
    const accumulator = createGeminiInteractionAccumulator();

    const events: AgentEvent[] = [
      ...accumulator.mapEvent(
        event({
          event_type: 'step.start',
          index: 0,
          step: { type: 'function_call', id: 'fc_1', name: 'search', arguments: {} },
        })
      ),
      ...accumulator.mapEvent(
        event({
          event_type: 'step.delta',
          index: 0,
          delta: { type: 'arguments_delta', arguments: '{"query":' },
        })
      ),
      ...accumulator.mapEvent(
        event({
          event_type: 'step.delta',
          index: 0,
          delta: { type: 'arguments_delta', arguments: '"cats"}' },
        })
      ),
      ...accumulator.mapEvent(event({ event_type: 'step.stop', index: 0 })),
    ];

    expect(events).toEqual([
      { type: 'tool_call_started', callId: 'fc_1', name: 'search' },
      { type: 'tool_call_arguments_delta', callId: 'fc_1', delta: '{"query":' },
      { type: 'tool_call_arguments_delta', callId: 'fc_1', delta: '"cats"}' },
      {
        type: 'tool_call_completed',
        callId: 'fc_1',
        name: 'search',
        arguments: '{"query":"cats"}',
      },
    ]);
  });

  it('falls back to the arguments sent whole on step.start when no delta streams', () => {
    const accumulator = createGeminiInteractionAccumulator();

    accumulator.mapEvent(
      event({
        event_type: 'step.start',
        index: 0,
        step: { type: 'function_call', id: 'fc_whole', name: 'lookup', arguments: { q: 1 } },
      })
    );

    expect(accumulator.mapEvent(event({ event_type: 'step.stop', index: 0 }))).toEqual([
      {
        type: 'tool_call_completed',
        callId: 'fc_whole',
        name: 'lookup',
        arguments: '{"q":1}',
      },
    ]);
  });

  it('falls back to the opening arguments when the delta buffer is truncated', () => {
    const accumulator = createGeminiInteractionAccumulator();

    accumulator.mapEvent(
      event({
        event_type: 'step.start',
        index: 0,
        step: { type: 'function_call', id: 'fc_cut', name: 'lookup', arguments: { q: 'fallback' } },
      })
    );
    accumulator.mapEvent(
      event({
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'arguments_delta', arguments: '{"q":' },
      })
    );

    expect(accumulator.mapEvent(event({ event_type: 'step.stop', index: 0 }))).toEqual([
      {
        type: 'tool_call_completed',
        callId: 'fc_cut',
        name: 'lookup',
        arguments: '{"q":"fallback"}',
      },
    ]);
  });

  it('tracks a nameless function call without announcing it', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'step.start',
          index: 0,
          step: { type: 'function_call', id: 'fc_2', name: '', arguments: {} },
        })
      )
    ).toEqual([]);

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'step.delta',
          index: 0,
          delta: { type: 'arguments_delta', arguments: '{"q":1}' },
        })
      )
    ).toEqual([{ type: 'tool_call_arguments_delta', callId: 'fc_2', delta: '{"q":1}' }]);
  });

  it('maps text and thought-summary deltas, ignoring thought signatures', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'step.delta',
          index: 0,
          delta: { type: 'thought_summary', content: { type: 'text', text: 'Thinking.' } },
        })
      )
    ).toEqual([{ type: 'reasoning_delta', text: 'Thinking.' }]);

    expect(
      accumulator.mapEvent(
        event({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Answer.' } })
      )
    ).toEqual([{ type: 'assistant_text_delta', text: 'Answer.' }]);

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'step.delta',
          index: 0,
          delta: { type: 'thought_signature', signature: 'sig' },
        })
      )
    ).toEqual([]);
  });

  it('does not render a model_output step that arrives already populated', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'step.start',
          index: 0,
          step: { type: 'model_output', content: [{ type: 'text', text: 'Whole answer.' }] },
        })
      )
    ).toEqual([]);
  });

  it('captures interaction id and usage on completion', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'interaction.completed',
          interaction: {
            id: 'int_done',
            status: 'completed',
            usage: { total_input_tokens: 99, total_cached_tokens: 33 },
          },
        })
      )
    ).toEqual([]);

    expect(accumulator.interactionId).toBe('int_done');
    expect(accumulator.providerReportedInputTokens).toBe(99);
  });

  it('captures interaction id from interaction.created', () => {
    const accumulator = createGeminiInteractionAccumulator();

    accumulator.mapEvent(
      event({
        event_type: 'interaction.created',
        interaction: { id: 'int_started', status: 'in_progress' },
      })
    );

    expect(accumulator.interactionId).toBe('int_started');
    expect(accumulator.providerReportedInputTokens).toBeUndefined();
  });

  it('skips usage when completion reports zero input tokens', () => {
    const accumulator = createGeminiInteractionAccumulator();

    accumulator.mapEvent(
      event({
        event_type: 'interaction.completed',
        interaction: { id: 'int_zero', status: 'completed', usage: { total_input_tokens: 0 } },
      })
    );

    expect(accumulator.providerReportedInputTokens).toBeUndefined();
  });

  it('ignores deltas for unknown call indexes', () => {
    const accumulator = createGeminiInteractionAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          event_type: 'step.delta',
          index: 5,
          delta: { type: 'arguments_delta', arguments: '{}' },
        })
      )
    ).toEqual([]);
    expect(accumulator.mapEvent(event({ event_type: 'step.stop', index: 5 }))).toEqual([]);
  });
});
