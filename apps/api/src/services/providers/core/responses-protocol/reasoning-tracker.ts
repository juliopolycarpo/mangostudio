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
 * A reasoning item carries its summary as separate parts (`summary_index`), or its raw
 * text as separate content parts (`content_index`), each a paragraph of its own that
 * usually opens with a bold title. The stream gives only the text of each part, so the
 * tracker prefixes a blank line to the first text of every part after the first, across
 * reasoning items too. That is the same join `extractReasoningFromCompleted` uses, so the
 * streamed text and the completed-response fallback read the same whenever both paths see
 * one kind of part. They can differ when a turn mixes kinds: the fallback prefers summaries
 * over raw content, but raw text already streamed cannot be retracted, so the stream keeps
 * it (and the fallback never runs after anything streamed). Without the separator the stored
 * text reads "…end of one part.**Next title**…". The
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

/** Joins two reasoning parts, matching the join used for a completed response. */
const REASONING_PART_SEPARATOR = '\n\n';

/** Builds a reasoning tracker for a single Responses stream. */
// Usage: const reasoning = createResponsesReasoningTracker();
export function createResponsesReasoningTracker(): ResponsesReasoningTracker {
  /** Summary parts (`item_id:summary_index`) whose text was streamed as deltas or emitted by a done event. */
  const emittedSummaryParts = new Set<string>();
  /** Raw text parts (`item_id:content_index`) whose text was streamed as deltas or emitted by a done event. */
  const emittedRawParts = new Set<string>();
  let summaryEventsWereSeen = false;
  let thinkingWasEmitted = false;
  /** The part whose text was emitted last, as `kind:item_id:index`. */
  let lastEmittedPart: string | null = null;

  const emit = (text: string | undefined | null): string | null => {
    if (!text) return null;
    thinkingWasEmitted = true;
    return text;
  };

  /**
   * Emits text of one part, opening a new paragraph when it belongs to a different part than
   * the text emitted before it. Summary parts and raw text parts each form their own paragraphs.
   */
  const emitPart = (
    kind: 'summary' | 'raw',
    itemId: string,
    partIndex: number,
    text: string | undefined | null
  ): string | null => {
    if (!text) return null;
    const part = `${kind}:${itemId}:${partIndex}`;
    const separator = lastEmittedPart !== null && lastEmittedPart !== part;
    lastEmittedPart = part;
    return emit(separator ? `${REASONING_PART_SEPARATOR}${text}` : text);
  };

  /** Emits what a summary done event carries, once per part however many done events name it. */
  const emitSummaryDone = (
    itemId: string,
    summaryIndex: number,
    text: string | undefined | null
  ): string | null => {
    const key = `${itemId}:${summaryIndex}`;
    if (emittedSummaryParts.has(key)) return null;
    const emitted = emitPart('summary', itemId, summaryIndex, text);
    if (emitted !== null) {
      emittedSummaryParts.add(key);
      summaryEventsWereSeen = true;
    }
    return emitted;
  };

  return {
    consumeStreamEvent(ev) {
      switch (ev.type) {
        // Reasoning summary (preferred path).
        case 'response.reasoning_summary_text.delta': {
          emittedSummaryParts.add(`${ev.item_id}:${ev.summary_index}`);
          summaryEventsWereSeen = true;
          return emitPart('summary', ev.item_id, ev.summary_index, ev.delta);
        }

        // Raw reasoning text (fallback when no summary is streamed).
        case 'response.reasoning_text.delta': {
          if (summaryEventsWereSeen) return null;
          emittedRawParts.add(`${ev.item_id}:${ev.content_index}`);
          return emitPart('raw', ev.item_id, ev.content_index, ev.delta);
        }

        // Summary done events (fallback if the matching delta never streamed).
        case 'response.reasoning_summary_text.done':
          return emitSummaryDone(ev.item_id, ev.summary_index, ev.text);

        case 'response.reasoning_summary_part.done':
          return emitSummaryDone(ev.item_id, ev.summary_index, ev.part.text);

        case 'response.reasoning_text.done': {
          const key = `${ev.item_id}:${ev.content_index}`;
          if (summaryEventsWereSeen || emittedRawParts.has(key)) return null;
          const emitted = emitPart('raw', ev.item_id, ev.content_index, ev.text);
          if (emitted !== null) emittedRawParts.add(key);
          return emitted;
        }

        // Answer text or a tool call ends the reasoning phase. The turn opens a new thinking
        // part for the next reasoning item, so its first text must not carry a separator.
        case 'response.output_text.delta': {
          lastEmittedPart = null;
          return null;
        }

        case 'response.output_item.added': {
          if (ev.item.type !== 'reasoning') lastEmittedPart = null;
          return null;
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
