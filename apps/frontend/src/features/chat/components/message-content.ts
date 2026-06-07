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
  let textRun = '';

  const flushRuns = () => {
    if (thinkingRun) {
      normalized.push({ type: 'thinking', text: thinkingRun });
      thinkingRun = '';
    }
    if (textRun) {
      normalized.push({ type: 'text', text: textRun });
      textRun = '';
    }
  };

  for (const part of parts) {
    if (part.type === 'thinking') {
      thinkingRun += part.text;
      continue;
    }
    if (part.type === 'text') {
      textRun += part.text;
      continue;
    }
    flushRuns();
    normalized.push(part);
  }

  flushRuns();
  return normalized;
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
