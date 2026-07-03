/**
 * Reasoning-event deduplication for the Responses protocol stream.
 *
 * The Responses API emits reasoning across several event families (summary
 * deltas, raw text deltas, and their `.done` variants) that can overlap.
 * This tracker collapses them into a single ordered stream of reasoning text,
 * preferring summary events and never emitting the same chunk twice. The
 * neutral `string` output lets both the text-streaming and agentic-turn
 * generators wrap it in their own event shape (`thinking` vs `reasoning_delta`).
 */

import type { Responses } from 'openai/resources/responses/responses';
import type { ResponseStreamEvent } from './normalizers';
import { extractReasoningFromCompleted } from './normalizers';

export interface ResponsesReasoningTracker {
  /**
   * Returns the reasoning text to emit for a streamed event, or null when the
   * event carries no new reasoning (non-reasoning event, empty, or duplicate).
   */
  consumeStreamEvent(ev: ResponseStreamEvent): string | null;
  /**
   * Returns reasoning text recovered from a completed response when nothing was
   * streamed during the turn, or null when reasoning was already emitted.
   */
  consumeCompleted(response: Responses.Response): string | null;
}

/** Builds a reasoning tracker for a single Responses stream. */
// Usage: const reasoning = createResponsesReasoningTracker();
export function createResponsesReasoningTracker(): ResponsesReasoningTracker {
  const seenSummaryDeltas = new Set<string>();
  let summaryEventsWereSeen = false;
  let thinkingWasEmitted = false;

  const emit = (text: string | undefined | null): string | null => {
    if (!text) return null;
    thinkingWasEmitted = true;
    return text;
  };

  return {
    consumeStreamEvent(ev) {
      switch (ev.type) {
        // Reasoning summary (preferred path).
        case 'response.reasoning_summary_text.delta': {
          seenSummaryDeltas.add(`${ev.item_id}:${ev.summary_index}`);
          summaryEventsWereSeen = true;
          return emit(ev.delta);
        }

        // Raw reasoning text (fallback when no summary is streamed).
        case 'response.reasoning_text.delta': {
          if (summaryEventsWereSeen) return null;
          return emit(ev.delta);
        }

        // Summary done events (fallback if the matching delta never streamed).
        case 'response.reasoning_summary_text.done': {
          if (seenSummaryDeltas.has(`${ev.item_id}:${ev.summary_index}`)) return null;
          return emit(ev.text);
        }

        case 'response.reasoning_summary_part.done': {
          if (seenSummaryDeltas.has(`${ev.item_id}:${ev.summary_index}`)) return null;
          return emit(ev.part.text);
        }

        case 'response.reasoning_text.done': {
          if (summaryEventsWereSeen || thinkingWasEmitted) return null;
          return emit(ev.text);
        }

        default:
          return null;
      }
    },

    consumeCompleted(response) {
      if (thinkingWasEmitted) return null;
      return extractReasoningFromCompleted(response);
    },
  };
}
