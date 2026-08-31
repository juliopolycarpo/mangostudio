import type { Message, MessagePart } from '@mangostudio/shared';

/** The two part kinds that arrive as a stream of deltas and read as one block. */
type MergeableRun = Extract<MessagePart, { type: 'thinking' | 'text' }>;

function isMergeable(part: MessagePart): part is MergeableRun {
  return part.type === 'thinking' || part.type === 'text';
}

/**
 * Collapses token-level streaming parts into stable display blocks.
 *
 * Streaming emits thinking/text one token at a time, so a single logical
 * paragraph can arrive as dozens of adjacent parts. Merging *adjacent* runs
 * keeps the rendered list short and prevents per-token remounts.
 *
 * Adjacency is the whole rule, and it is deliberately narrow. Holding a run
 * open across the other kind reordered the turn: a model that answers,
 * reconsiders and answers again had both answers welded together beneath the
 * thought that separated them, and the live thought — now sitting at index 0 —
 * stopped being the last part, which is how the renderer decides what is still
 * streaming. Alternation is not a glitch to smooth over; it is the tool loop
 * made visible, and it is what the turn actually did.
 *
 * The fold reads exactly two things per step: the incoming part and the
 * trailing one. No earlier entry is revisited or reordered, so appending to
 * `parts` never changes an index below the last — which is what makes the
 * positional liveness check and the `${messageId}-thinking-${idx}` keys sound.
 * One caveat, and only one: the stream reducer's `closeThinkingAt` splices out
 * a *displaced* empty thinking phase, which shifts later indices down. It fires
 * only against a runtime too old to send `reasoning_ended`, and only on a
 * contentless phase, so nothing may be built that needs the invariant absolute.
 *
 * The same rule is applied by `mergeMessageParts` before persisting and by the
 * stream reducer while streaming. All three have to agree, or a live turn and
 * its reloaded self disagree.
 *
 * Usage: normalizeMessageParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
 */
export function normalizeMessageParts(parts: MessagePart[]): MessagePart[] {
  const normalized: MessagePart[] = [];

  for (const part of parts) {
    if (!isMergeable(part)) {
      normalized.push(part);
      continue;
    }
    // Prose with no text says nothing. Unlike `thinking`, no event opens an
    // empty text phase, so an empty text part is noise rather than a signal.
    //
    // An empty `thinking` part survives unconditionally. A reasoning phase that
    // received no `thinking_delta` at all is the common case rather than the
    // exception — `display: "omitted"` is the API default on current models —
    // and `reasoning_started` opens an empty `thinking` part precisely so the
    // reader sees that phase happening. Dropping an empty phase is decided
    // where it becomes knowable — the transcript's `#closeThinking` and the
    // stream reducer's `closeThinkingAt` — not here.
    if (part.type === 'text' && part.text === '') continue;

    const previous = normalized.at(-1);
    if (!previous || !isMergeable(previous) || previous.type !== part.type) {
      normalized.push(part);
      continue;
    }
    normalized[normalized.length - 1] = {
      type: part.type,
      text: previous.text + part.text,
      ...mergeFlags(previous, part),
    } as MergeableRun;
  }

  return normalized;
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

/**
 * Resolves a message into normalized parts, falling back to legacy `text`.
 *
 * Usage: messagePartsFromMessage({ text: 'hi', parts: undefined })
 */
export function messagePartsFromMessage(msg: Message): MessagePart[] {
  return normalizeMessageParts(msg.parts ?? (msg.text ? [{ type: 'text', text: msg.text }] : []));
}

/**
 * True when a message belongs to an image-generation turn, including legacy
 * messages that only carry an `imageUrl` without an explicit interaction mode.
 *
 * Usage: isImageInteraction({ interactionMode: 'image' })
 */
export function isImageInteraction(msg: Message): boolean {
  return msg.interactionMode === 'image' || (!msg.interactionMode && !!msg.imageUrl);
}

/**
 * Joins a message's text parts into raw markdown for clipboard copy.
 *
 * Usage: extractRawMarkdown(msg)
 */
export function extractRawMarkdown(msg: Message): string {
  return messagePartsFromMessage(msg)
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}
