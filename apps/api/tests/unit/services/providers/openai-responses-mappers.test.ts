import { describe, expect, it } from 'bun:test';

import { appendMergedMessagePart } from '@mangostudio/shared/generation';
import type { MessagePart } from '@mangostudio/shared/types';
import type { Responses } from 'openai/resources/responses/responses';

import { CheckpointPlanner } from '../../../../src/modules/generation/application/turn-checkpoint-delta';
import { foldCheckpointDeltas } from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';
import {
  extractReasoningFromCompleted,
  type ResponseStreamEvent,
} from '../../../../src/services/providers/openai/normalizers';
import { createResponsesAgentAccumulator } from '../../../../src/services/providers/openai/responses-agent-accumulator';
import { createResponsesReasoningTracker } from '../../../../src/services/providers/openai/responses-reasoning-tracker';
import type { AgentEvent } from '../../../../src/services/providers/types';

/** Casts a plain fake chunk to the SDK stream-event union for replay. */
function event(data: Record<string, unknown>): ResponseStreamEvent {
  return data as unknown as ResponseStreamEvent;
}

/** Casts a plain fake completed response to the SDK Response type. */
function completedResponse(data: Record<string, unknown>): Responses.Response {
  return data as unknown as Responses.Response;
}

// ---------------------------------------------------------------------------
// createResponsesReasoningTracker
// ---------------------------------------------------------------------------

describe('createResponsesReasoningTracker', () => {
  it('emits summary delta text and dedups the matching done event', () => {
    const tracker = createResponsesReasoningTracker();

    expect(
      tracker.consumeStreamEvent(
        event({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'item1',
          summary_index: 0,
          delta: 'Streamed thinking.',
        })
      )
    ).toBe('Streamed thinking.');

    // The done event for the same (item_id, summary_index) is a duplicate.
    expect(
      tracker.consumeStreamEvent(
        event({
          type: 'response.reasoning_summary_text.done',
          item_id: 'item1',
          summary_index: 0,
          text: 'Streamed thinking.',
        })
      )
    ).toBeNull();
  });

  it('emits summary done text when no matching delta streamed', () => {
    const tracker = createResponsesReasoningTracker();

    expect(
      tracker.consumeStreamEvent(
        event({
          type: 'response.reasoning_summary_text.done',
          item_id: 'item1',
          summary_index: 0,
          text: 'Only done.',
        })
      )
    ).toBe('Only done.');
  });

  it('emits raw reasoning_text.delta only until summary events appear', () => {
    const tracker = createResponsesReasoningTracker();

    expect(
      tracker.consumeStreamEvent(
        event({ type: 'response.reasoning_text.delta', delta: 'Raw reasoning.' })
      )
    ).toBe('Raw reasoning.');

    tracker.consumeStreamEvent(
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Summary.',
      })
    );

    // Once summary events are seen, raw reasoning text is suppressed.
    expect(
      tracker.consumeStreamEvent(
        event({ type: 'response.reasoning_text.delta', delta: 'Raw duplicate.' })
      )
    ).toBeNull();
  });

  it('emits summary part done text and dedups by index', () => {
    const tracker = createResponsesReasoningTracker();

    expect(
      tracker.consumeStreamEvent(
        event({
          type: 'response.reasoning_summary_part.done',
          item_id: 'item1',
          summary_index: 2,
          part: { text: 'Part text.' },
        })
      )
    ).toBe('Part text.');
  });

  describe('summary parts', () => {
    const summaryDelta = (itemId: string, summaryIndex: number, delta: string) =>
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: itemId,
        summary_index: summaryIndex,
        delta,
      });

    it('opens each later summary part with a blank line, once, ahead of its first text', () => {
      const tracker = createResponsesReasoningTracker();

      const streamed = [
        summaryDelta('item1', 0, '**Plan**'),
        summaryDelta('item1', 0, ' end of first part.'),
        summaryDelta('item1', 1, '**Check**'),
        summaryDelta('item1', 1, ' end of second part.'),
        summaryDelta('item1', 2, '**Answer**'),
      ].map((ev) => tracker.consumeStreamEvent(ev));

      expect(streamed).toEqual([
        '**Plan**',
        ' end of first part.',
        '\n\n**Check**',
        ' end of second part.',
        '\n\n**Answer**',
      ]);
    });

    it('joins streamed parts the way a completed response joins them', () => {
      const tracker = createResponsesReasoningTracker();
      const streamed = [
        summaryDelta('item1', 0, 'First part.'),
        summaryDelta('item1', 1, 'Second part.'),
      ]
        .map((ev) => tracker.consumeStreamEvent(ev))
        .join('');

      const completed = extractReasoningFromCompleted(
        completedResponse({
          output: [
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'First part.' },
                { type: 'summary_text', text: 'Second part.' },
              ],
            },
          ],
        })
      );

      expect(streamed).toBe(completed ?? '');
    });

    it('leaves a single summary part, and its done event, exactly as streamed', () => {
      const tracker = createResponsesReasoningTracker();

      const streamed = [
        summaryDelta('item1', 0, 'Only '),
        summaryDelta('item1', 0, 'part.'),
        event({
          type: 'response.reasoning_summary_text.done',
          item_id: 'item1',
          summary_index: 0,
          text: 'Only part.',
        }),
      ].map((ev) => tracker.consumeStreamEvent(ev));

      expect(streamed).toEqual(['Only ', 'part.', null]);
    });

    it('separates a part recovered from its done events, and one from a second reasoning item', () => {
      const tracker = createResponsesReasoningTracker();

      expect(tracker.consumeStreamEvent(summaryDelta('item1', 0, 'First.'))).toBe('First.');
      expect(
        tracker.consumeStreamEvent(
          event({
            type: 'response.reasoning_summary_text.done',
            item_id: 'item1',
            summary_index: 1,
            text: 'Second.',
          })
        )
      ).toBe('\n\nSecond.');
      expect(
        tracker.consumeStreamEvent(
          event({
            type: 'response.reasoning_summary_part.done',
            item_id: 'item2',
            summary_index: 0,
            part: { text: 'Third.' },
          })
        )
      ).toBe('\n\nThird.');
    });

    it('does not open a paragraph for an empty delta', () => {
      const tracker = createResponsesReasoningTracker();

      expect(tracker.consumeStreamEvent(summaryDelta('item1', 0, 'First.'))).toBe('First.');
      expect(tracker.consumeStreamEvent(summaryDelta('item1', 1, ''))).toBeNull();
      expect(tracker.consumeStreamEvent(summaryDelta('item1', 1, 'Second.'))).toBe('\n\nSecond.');
    });

    it('lets a checkpoint store the stream by appending only', () => {
      const tracker = createResponsesReasoningTracker();
      const planner = new CheckpointPlanner();
      const parts: MessagePart[] = [];
      let stored = foldCheckpointDeltas(
        { text: '', parts: [], providerState: null, generationTime: null },
        []
      );
      const checkpointAfter = (ev: ResponseStreamEvent) => {
        const text = tracker.consumeStreamEvent(ev);
        if (text) appendMergedMessagePart(parts, { type: 'thinking', text });
        const plan = planner.plan({ text: '', parts, providerState: null });
        if (plan.kind === 'rebase') {
          stored = {
            text: plan.text,
            parts: JSON.parse(plan.partsJson) as MessagePart[],
            providerState: null,
            generationTime: null,
          };
          return plan;
        }
        stored = foldCheckpointDeltas(stored, [JSON.parse(plan.deltaJson)]);
        return plan;
      };

      checkpointAfter(summaryDelta('item1', 0, 'First part.'));
      const secondPartPlan = checkpointAfter(summaryDelta('item1', 1, 'Second part.'));

      // The separator rides in the second part's append; the first part's stored text is untouched.
      expect(secondPartPlan.kind).toBe('delta');
      if (secondPartPlan.kind === 'delta') {
        expect(JSON.parse(secondPartPlan.deltaJson)).toMatchObject({
          ops: [{ i: 0, append: '\n\nSecond part.' }],
        });
      }
      expect(stored.parts).toEqual([{ type: 'thinking', text: 'First part.\n\nSecond part.' }]);
    });
  });

  it('emits reasoning_text.done only when nothing else was emitted', () => {
    const tracker = createResponsesReasoningTracker();

    expect(
      tracker.consumeStreamEvent(
        event({ type: 'response.reasoning_text.done', text: 'Final raw reasoning.' })
      )
    ).toBe('Final raw reasoning.');

    // A second reasoning_text.done is suppressed because reasoning was emitted.
    expect(
      tracker.consumeStreamEvent(event({ type: 'response.reasoning_text.done', text: 'Again.' }))
    ).toBeNull();
  });

  it('returns null for non-reasoning events', () => {
    const tracker = createResponsesReasoningTracker();

    expect(
      tracker.consumeStreamEvent(event({ type: 'response.output_text.delta', delta: 'Answer.' }))
    ).toBeNull();
  });

  it('recovers reasoning from a completed response only when nothing streamed', () => {
    const tracker = createResponsesReasoningTracker();
    const response = completedResponse({
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Recovered.' }] }],
    });

    expect(tracker.consumeCompleted(response)).toBe('Recovered.');
  });

  it('suppresses completed fallback after streamed reasoning', () => {
    const tracker = createResponsesReasoningTracker();
    tracker.consumeStreamEvent(
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Streamed.',
      })
    );

    const response = completedResponse({
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Recovered.' }] }],
    });
    expect(tracker.consumeCompleted(response)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createResponsesAgentAccumulator
// ---------------------------------------------------------------------------

/** Maps a full event sequence to its flattened AgentEvent output. */
function mapAll(
  accumulator: ReturnType<typeof createResponsesAgentAccumulator>,
  events: ReturnType<typeof event>[]
): AgentEvent[] {
  return events.flatMap((ev) => accumulator.mapEvent(ev));
}

describe('createResponsesAgentAccumulator', () => {
  it('maps a tool call lifecycle keyed by output item id', () => {
    const accumulator = createResponsesAgentAccumulator();

    const events = mapAll(accumulator, [
      event({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search' },
      }),
      event({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"q":',
      }),
      event({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '"cats"}',
      }),
      event({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        arguments: '{"q":"cats"}',
      }),
    ]);

    expect(events).toEqual([
      { type: 'tool_call_started', callId: 'call_1', name: 'search' },
      { type: 'tool_call_arguments_delta', callId: 'call_1', delta: '{"q":' },
      { type: 'tool_call_arguments_delta', callId: 'call_1', delta: '"cats"}' },
      {
        type: 'tool_call_completed',
        callId: 'call_1',
        name: 'search',
        arguments: '{"q":"cats"}',
      },
    ]);
  });

  it('ignores argument deltas for unknown output items', () => {
    const accumulator = createResponsesAgentAccumulator();

    expect(
      accumulator.mapEvent(
        event({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_unknown',
          delta: '{}',
        })
      )
    ).toEqual([]);
  });

  it('maps text deltas and reasoning deltas', () => {
    const accumulator = createResponsesAgentAccumulator();

    const events = mapAll(accumulator, [
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Pondering.',
      }),
      event({ type: 'response.output_text.delta', delta: 'Hello' }),
      event({ type: 'response.output_text.delta', delta: ' world' }),
    ]);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'Pondering.' },
      { type: 'assistant_text_delta', text: 'Hello' },
      { type: 'assistant_text_delta', text: ' world' },
    ]);
  });

  it('separates summary parts in reasoning deltas and leaves the replayable output items untouched', () => {
    const accumulator = createResponsesAgentAccumulator();
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'enc_blob==',
      summary: [
        { type: 'summary_text', text: 'First part.' },
        { type: 'summary_text', text: 'Second part.' },
      ],
    };

    const events = mapAll(accumulator, [
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'First part.',
      }),
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 1,
        delta: 'Second part.',
      }),
      event({
        type: 'response.completed',
        response: { id: 'resp_two_parts', output: [structuredClone(reasoningItem)] },
      }),
    ]);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'First part.' },
      { type: 'reasoning_delta', text: '\n\nSecond part.' },
    ]);
    // What a stateless replay sends back to the provider is the item as received, byte for byte.
    expect(accumulator.outputItems).toEqual([reasoningItem]);
    expect(JSON.stringify(accumulator.outputItems)).toBe(JSON.stringify([reasoningItem]));
  });

  it('captures response id and input-token usage on completion', () => {
    const accumulator = createResponsesAgentAccumulator();

    const events = accumulator.mapEvent(
      event({
        type: 'response.completed',
        response: { id: 'resp_new', usage: { input_tokens: 321, output_tokens: 10 } },
      })
    );

    expect(events).toEqual([]);
    expect(accumulator.responseId).toBe('resp_new');
    expect(accumulator.usageInputTokens).toBe(321);
  });

  it('emits completed reasoning fallback when nothing streamed', () => {
    const accumulator = createResponsesAgentAccumulator();

    const events = accumulator.mapEvent(
      event({
        type: 'response.completed',
        response: {
          id: 'resp_fallback',
          output: [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Recovered reasoning.' }],
            },
          ],
        },
      })
    );

    expect(events).toEqual([{ type: 'reasoning_delta', text: 'Recovered reasoning.' }]);
    expect(accumulator.responseId).toBe('resp_fallback');
  });

  it('skips usage when completed reports zero input tokens', () => {
    const accumulator = createResponsesAgentAccumulator();

    accumulator.mapEvent(
      event({
        type: 'response.completed',
        response: { id: 'resp_zero', usage: { input_tokens: 0, output_tokens: 10 } },
      })
    );

    expect(accumulator.usageInputTokens).toBeUndefined();
  });
});
