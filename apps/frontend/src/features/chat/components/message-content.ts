import type { Message, MessagePart } from '@mangostudio/shared';

/**
 * Collapses token-level streaming parts into stable display blocks.
 *
 * Streaming emits thinking/text one token at a time, so a single logical
 * paragraph can arrive as dozens of adjacent parts. Merging consecutive runs
 * keeps the rendered list short and prevents per-token remounts.
 *
 * Usage: normalizeMessageParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
 */
export function normalizeMessageParts(parts: MessagePart[]): MessagePart[] {
  const normalized: MessagePart[] = [];
  // Held on one object rather than in four `let`s: `flushRuns` closes over
  // them, and a captured binding seeded with `null` reads as `null` inside the
  // closure however it is reassigned afterwards.
  const pending: { thinking: MergedRun | null; text: MergedRun | null } = {
    thinking: null,
    text: null,
  };

  const flushRuns = () => {
    const { thinking, text } = pending;
    pending.thinking = null;
    pending.text = null;
    // The thinking run is emitted on *existence*, not on having text. A
    // reasoning phase that received no `thinking_delta` at all is the common
    // case rather than the exception — `display: "omitted"` is the API default
    // on current models — and `reasoning_started` opens an empty `thinking`
    // part precisely so the reader sees that phase happening. Keying this on
    // the text instead deleted that part before it could ever render, so the
    // one event announcing a withheld reasoning phase showed nothing at all.
    // Dropping an empty phase is decided where it becomes knowable — the
    // transcript's `#closeThinking` and the stream reducer's `closeThinkingAt`
    // — not here.
    if (thinking) normalized.push({ type: 'thinking', text: thinking.text, ...thinking.flags });
    if (text?.text) normalized.push({ type: 'text', text: text.text, ...text.flags });
  };

  for (const part of parts) {
    if (part.type === 'thinking') {
      pending.thinking = extendRun(pending.thinking, part);
      continue;
    }
    if (part.type === 'text') {
      pending.text = extendRun(pending.text, part);
      continue;
    }
    flushRuns();
    normalized.push(part);
  }

  flushRuns();
  return normalized;
}

/** One run of same-kind parts, joined: its text and the flags it carries. */
interface MergedRun {
  readonly text: string;
  readonly flags: PartFlags;
}

/** Folds one more part into the run it is joining, opening the run if it is the first. */
function extendRun(
  run: MergedRun | null,
  part: { text: string; redacted?: boolean; incomplete?: true }
): MergedRun {
  return { text: (run?.text ?? '') + part.text, flags: mergeFlags(run?.flags ?? {}, part) };
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
function mergeFlags(flags: PartFlags, part: { redacted?: boolean; incomplete?: true }): PartFlags {
  return {
    ...(flags.redacted || part.redacted ? { redacted: true } : {}),
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
