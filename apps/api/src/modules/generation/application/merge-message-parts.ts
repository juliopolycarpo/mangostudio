import type { MessagePart } from '@mangostudio/shared';

/** The two part kinds that arrive as a stream of deltas and read as one block. */
type MergeableRun = Extract<MessagePart, { type: 'thinking' | 'text' }>;

function isMergeable(part: MessagePart): part is MergeableRun {
  return part.type === 'thinking' || part.type === 'text';
}

/**
 * Coalesce *adjacent* thinking/text parts into single runs so the persisted
 * message stores one part per contiguous segment instead of per delta.
 *
 * Adjacency is the whole rule. Holding a run open across the other kind
 * reordered the turn on the way into the database: a model that answered,
 * reconsidered and answered again was stored with both answers welded together
 * beneath the thought that separated them, so the transcript claimed an order
 * the model never produced. Alternation is not noise to smooth over; the
 * adapters feed this from ordered events, so where it survives to here it is
 * what actually happened.
 *
 * A leaf on purpose: the frontend applies the same rule twice — in
 * `normalizeMessageParts` while rendering and in the stream reducer while
 * streaming — and all three have to agree or a live turn and its reloaded self
 * disagree. Keeping this import-free is what lets a test hold them side by side.
 *
 * Idempotent, because a stored row is re-merged on every continuation.
 *
 * // Usage: const parts = mergeMessageParts(allParts);
 */
export function mergeMessageParts(allParts: MessagePart[]): MessagePart[] {
  const finalParts: MessagePart[] = [];

  for (const part of allParts) {
    if (!isMergeable(part)) {
      finalParts.push(part);
      continue;
    }
    // Prose with no text says nothing. Unlike `thinking`, no event opens an
    // empty text phase, so an empty text part is noise rather than a signal.
    if (part.type === 'text' && part.text === '') continue;

    const previous = finalParts.at(-1);
    if (!previous || !isMergeable(previous) || previous.type !== part.type) {
      finalParts.push(part);
      continue;
    }
    finalParts[finalParts.length - 1] = {
      type: part.type,
      text: previous.text + part.text,
      ...mergeFlags(previous, part),
    } as MergeableRun;
  }

  return finalParts;
}

/**
 * Folds one part's flags into the run it is joining.
 *
 * `incomplete` is taken from the newest part rather than sticking, because it
 * describes where the run *ends*: a block that was cut short and then continued
 * was not cut short. `redacted` sticks, because a run that hid any of its
 * content is not fully shown no matter what followed. The frontend's
 * `normalizeMessageParts` says exactly this, and has to.
 */
function mergeFlags(
  previous: { redacted?: boolean; incomplete?: true },
  part: { redacted?: boolean; incomplete?: true }
): { redacted?: true; incomplete?: true } {
  return {
    ...(previous.redacted || part.redacted ? { redacted: true } : {}),
    ...(part.incomplete ? { incomplete: true } : {}),
  };
}
