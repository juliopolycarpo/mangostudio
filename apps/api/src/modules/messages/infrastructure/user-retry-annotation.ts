import type { MessagePart } from '@mangostudio/shared/types';

/**
 * The one line the model reads above a result the user asked for. Without it a
 * re-run looks like the model's own call that it never made, and a transcript
 * where the same call appears twice reads as a loop.
 */
export const USER_RETRY_NOTE =
  '[The user re-ran this tool call themselves after it did not finish; you did not request it.]';

/**
 * Returns `parts` with the {@link USER_RETRY_NOTE} on the result of every call
 * the user started, and leaves the stored parts untouched: the note is for the
 * model, so it is added when history is built, not persisted.
 *
 * Returns the same array when no call was user-initiated.
 *
 * // Usage: annotateUserRetriedToolResults(parts)
 */
export function annotateUserRetriedToolResults(parts: MessagePart[]): MessagePart[] {
  const userCallIds = new Set<string>();
  for (const part of parts) {
    if (part.type === 'tool_call' && part.initiatedBy === 'user') userCallIds.add(part.toolCallId);
  }
  if (userCallIds.size === 0) return parts;

  return parts.map((part) => {
    if (part.type !== 'tool_result' || !userCallIds.has(part.toolCallId)) return part;
    // Idempotent: a part that already carries the note is passed through.
    if (part.content.startsWith(USER_RETRY_NOTE)) return part;
    return { ...part, content: `${USER_RETRY_NOTE}\n${part.content}` };
  });
}
