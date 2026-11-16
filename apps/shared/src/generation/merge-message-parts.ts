import type { MessagePart } from '../types/agent-events';

/** The two part kinds that arrive as a stream of deltas and read as one block. */
type MergeableRun = Extract<MessagePart, { type: 'thinking' | 'text' }>;

function isMergeable(part: MessagePart): part is MergeableRun {
  return part.type === 'thinking' || part.type === 'text';
}

/**
 * Coalesce *adjacent* thinking/text parts into single runs so a turn reads as
 * one block per contiguous segment instead of per delta or per persisted row.
 *
 * Adjacency is the whole rule, and it is deliberately narrow. Holding a run
 * open across the other kind reordered the turn: a model that answers,
 * reconsiders and answers again had both answers welded together beneath the
 * thought that separated them, so the transcript claimed an order the model
 * never produced. Alternation is not noise to smooth over; it is what
 * actually happened, and it is also how the renderer decides what is still
 * streaming — the live part has to stay last.
 *
 * The API's stream-finalization path and the frontend's render path both call
 * this, and have to agree, or a live turn and its reloaded self disagree.
 *
 * Idempotent, because a stored row is re-merged on every continuation.
 *
 * Usage: mergeMessageParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
 */
export function mergeMessageParts(parts: MessagePart[]): MessagePart[] {
  const merged: MessagePart[] = [];
  for (const part of parts) appendMergedMessagePart(merged, part);
  return merged;
}

/**
 * Append one part to an already-merged list under the `mergeMessageParts`
 * rule, so a list built one part at a time stays merged as it grows.
 *
 * A streaming turn uses this per delta: without it the in-flight row holds a
 * part per token, and every checkpoint serializes all of them. Folding with
 * this function is `mergeMessageParts`, so the merged result is the same
 * whichever of the two built it.
 *
 * A joined run is a new object in the trailing slot. Neither `part` nor the
 * part it joins is mutated, because callers' arrays (frontend state, a parsed
 * row) may share those objects.
 *
 * Usage: appendMergedMessagePart(session.allParts, { type: 'text', text: delta })
 */
export function appendMergedMessagePart(merged: MessagePart[], part: MessagePart): void {
  if (!isMergeable(part)) {
    merged.push(part);
    return;
  }
  // Prose with no text says nothing. Unlike `thinking`, no event opens an
  // empty text phase, so an empty text part is noise rather than a signal.
  if (part.type === 'text' && part.text === '') return;

  const previous = merged.at(-1);
  if (!previous || !isMergeable(previous) || previous.type !== part.type) {
    merged.push(part);
    return;
  }
  merged[merged.length - 1] = {
    type: part.type,
    text: previous.text + part.text,
    ...mergeFlags(previous, part),
  } as MergeableRun;
}

/** Everything a merged run has to carry besides its text. */
interface PartFlags {
  redacted?: true;
  incomplete?: true;
}

/**
 * Folds one part's flags into the run it is joining.
 *
 * `incomplete` is taken from the newest part rather than sticking, because it
 * describes where the run *ends*: a block that was cut short and then continued
 * was not cut short. `redacted` sticks, because a run that hid any of its
 * content is not fully shown no matter what followed.
 */
function mergeFlags(
  previous: { redacted?: boolean; incomplete?: true },
  part: { redacted?: boolean; incomplete?: true }
): PartFlags {
  return {
    ...(previous.redacted || part.redacted ? { redacted: true } : {}),
    ...(part.incomplete ? { incomplete: true } : {}),
  };
}
