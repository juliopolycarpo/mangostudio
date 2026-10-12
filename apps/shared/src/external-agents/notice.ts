/**
 * Vendor notices as transcript parts.
 *
 * A notice is the vendor telling the person something outside the answer: a rate-limit warning,
 * a retry, a degraded mode. It is **display only**. The hub's live reducer and its durable
 * transcript both build the same part from it with {@link externalNoticePart}, so a reload shows
 * what the stream showed, and neither ever turns it into message text: a part of this type is
 * not `text`, so it is never part of the assistant message's `text` column, never replayed to a
 * model and never an instruction.
 *
 * Browser-safe: no Node builtins.
 */

import type { ExternalNoticePart, MessagePart } from '../types/agent-events';
import type { ExternalAgentEvent } from './schemas';

/**
 * How many notices one turn keeps. A vendor that announces a retry every second would otherwise
 * grow the message by a line a second for as long as the turn runs; the first few say what the
 * person needs, and the rest repeat it.
 */
export const MAX_EXTERNAL_NOTICES_PER_TURN = 8;

/** What a notice carries, as the `notice` event schema and the SSE chunk both spell it. */
export type ExternalNoticeFields = Omit<Extract<ExternalAgentEvent, { type: 'notice' }>, 'type'>;

/**
 * The part one notice becomes.
 *
 * @example
 * externalNoticePart({ severity: 'warning', title: 'Rate limit close' });
 * // { type: 'external_notice', severity: 'warning', title: 'Rate limit close' }
 */
export function externalNoticePart(notice: ExternalNoticeFields): ExternalNoticePart {
  return {
    type: 'external_notice',
    severity: notice.severity,
    title: notice.title,
    ...(notice.description !== undefined ? { description: notice.description } : {}),
  };
}

/**
 * Whether `parts` still has room for one more notice.
 *
 * @example
 * canAddExternalNotice([]); // true
 */
export function canAddExternalNotice(parts: readonly MessagePart[]): boolean {
  let kept = 0;
  for (const part of parts) {
    if (part.type === 'external_notice') kept += 1;
  }
  return kept < MAX_EXTERNAL_NOTICES_PER_TURN;
}

/**
 * The index of the last part that is not a notice, or -1.
 *
 * A notice is an aside, appended where it happened, so it must not become "the trailing part"
 * that the turn's rules read: the approval a turn is waiting on, the activity it is running, the
 * prose a cut-off turn stopped inside. Those rules ask for the last part of the turn itself.
 *
 * @example
 * lastContentIndex([text, notice]); // 0
 */
export function lastContentIndex(parts: readonly MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type !== 'external_notice') return index;
  }
  return -1;
}
