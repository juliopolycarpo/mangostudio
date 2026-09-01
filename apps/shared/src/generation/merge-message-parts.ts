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

  for (const part of parts) {
    if (!isMergeable(part)) {
      merged.push(part);
      continue;
    }
    // Prose with no text says nothing. Unlike `thinking`, no event opens an
    // empty text phase, so an empty text part is noise rather than a signal.
    if (part.type === 'text' && part.text === '') continue;

    const previous = merged.at(-1);
    if (!previous || !isMergeable(previous) || previous.type !== part.type) {
      merged.push(part);
      continue;
    }
    merged[merged.length - 1] = {
      type: part.type,
      text: previous.text + part.text,
      ...mergeFlags(previous, part),
    } as MergeableRun;
  }

  return merged;
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
