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
  let thinkingRun = '';
  let thinkingFlags: PartFlags = {};
  let textRun = '';
  let textFlags: PartFlags = {};

  const flushRuns = () => {
    if (thinkingRun) {
      normalized.push({ type: 'thinking', text: thinkingRun, ...thinkingFlags });
      thinkingRun = '';
      thinkingFlags = {};
    }
    if (textRun) {
      normalized.push({ type: 'text', text: textRun, ...textFlags });
      textRun = '';
      textFlags = {};
    }
  };

  for (const part of parts) {
    if (part.type === 'thinking') {
      thinkingRun += part.text;
      thinkingFlags = mergeFlags(thinkingFlags, part);
      continue;
    }
    if (part.type === 'text') {
      textRun += part.text;
      textFlags = mergeFlags(textFlags, part);
      continue;
    }
    flushRuns();
    normalized.push(part);
  }

  flushRuns();
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
