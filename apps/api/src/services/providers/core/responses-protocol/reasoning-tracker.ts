/**
 * Reasoning-event deduplication for the Responses protocol stream.
 *
 * The Responses API emits reasoning across several event families (summary
 * deltas, raw text deltas, and their `.done` variants) that can overlap.
 * This tracker collapses them into a single ordered stream of reasoning text,
 * preferring summary events and never emitting the same chunk twice. The
 * neutral `string` output lets both the text-streaming and agentic-turn
 * generators wrap it in their own event shape (`thinking` vs `reasoning_delta`).
 *
 * A reasoning item carries its summary as separate parts (`summary_index`), each
 * a paragraph of its own that usually opens with a bold title. The stream gives
 * only the text of each part, so the tracker appends a blank line to the first
 * text of every part after the first, the same join `extractReasoningFromCompleted`
 * uses. Without it the stored text reads "…end of one part.**Next title**…". The
 * separator travels in the stream, ahead of the text it precedes, so what was
 * already streamed and checkpointed only ever grows by appending.
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

/** Joins two summary parts, matching the join used for a completed response. */
const SUMMARY_PART_SEPARATOR = '\n\n';

/** Builds a reasoning tracker for a single Responses stream. */
// Usage: const reasoning = createResponsesReasoningTracker();
export function createResponsesReasoningTracker(): ResponsesReasoningTracker {
  const seenSummaryDeltas = new Set<string>();
  let summaryEventsWereSeen = false;
  let thinkingWasEmitted = false;
  /** The summary part whose text was emitted last, as `item_id:summary_index`. */
  let lastEmittedSummaryPart: string | null = null;

  const emit = (text: string | undefined | null): string | null => {
    if (!text) return null;
    thinkingWasEmitted = true;
    return text;
  };

  /** Emits summary text, opening a new paragraph when it belongs to a different part. */
  const emitSummary = (
    itemId: string,
    summaryIndex: number,
    text: string | undefined | null
  ): string | null => {
    if (!text) return null;
    const part = `${itemId}:${summaryIndex}`;
    const separator = lastEmittedSummaryPart !== null && lastEmittedSummaryPart !== part;
    lastEmittedSummaryPart = part;
    return emit(separator ? `${SUMMARY_PART_SEPARATOR}${text}` : text);
  };

  return {
    consumeStreamEvent(ev) {
      switch (ev.type) {
        // Reasoning summary (preferred path).
        case 'response.reasoning_summary_text.delta': {
          seenSummaryDeltas.add(`${ev.item_id}:${ev.summary_index}`);
          summaryEventsWereSeen = true;
          return emitSummary(ev.item_id, ev.summary_index, ev.delta);
        }

        // Raw reasoning text (fallback when no summary is streamed).
        case 'response.reasoning_text.delta': {
          if (summaryEventsWereSeen) return null;
          return emit(ev.delta);
        }

        // Summary done events (fallback if the matching delta never streamed).
        case 'response.reasoning_summary_text.done': {
          if (seenSummaryDeltas.has(`${ev.item_id}:${ev.summary_index}`)) return null;
          return emitSummary(ev.item_id, ev.summary_index, ev.text);
        }

        case 'response.reasoning_summary_part.done': {
          if (seenSummaryDeltas.has(`${ev.item_id}:${ev.summary_index}`)) return null;
          return emitSummary(ev.item_id, ev.summary_index, ev.part.text);
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
