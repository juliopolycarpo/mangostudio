import type { Message, MessagePart } from '@mangostudio/shared';
import { mergeMessageParts } from '@mangostudio/shared/generation';

/**
 * Collapses token-level streaming parts into stable display blocks.
 *
 * Streaming emits thinking/text one token at a time, so a single logical
 * paragraph can arrive as dozens of adjacent parts. This is the render half
 * of the adjacency rule `mergeMessageParts` applies before persisting; both
 * halves — plus the stream reducer while streaming — have to agree, or a live
 * turn and its reloaded self disagree. See `mergeMessageParts` for the rule
 * itself.
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
 * Usage: normalizeMessageParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
 */
export const normalizeMessageParts = mergeMessageParts;

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
