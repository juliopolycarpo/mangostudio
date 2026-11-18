import { useMessagesQuery } from '@/features/chat/queries';
import type { MessagesCache } from '@/features/chat/transcript-pages';

/**
 * True when every loaded page of the transcript is empty (also for no pages).
 *
 * It is the query's `select`, not a read after the fact: the observer then
 * holds a boolean, and a streamed reply patching the cache once per chunk
 * changes that boolean at most twice per turn. Reading `data` instead made
 * every observer of this hook (the layout, the runner selector, the command
 * registry) re-render once per chunk, and the layout carries the whole shell.
 */
export function selectTranscriptIsEmpty(data: MessagesCache): boolean {
  return data.pages.every((page) => page.messages.length === 0);
}

/**
 * Whether the chat already carries turns — the signal that fixes its identity.
 *
 * Once a chat has turns, its runner, environment and workdir are settled: the
 * transcript they produced belongs to that combination, and the controls that
 * would change them lock (or offer "continue in a new chat") instead of
 * repointing a conversation in place. D14's runner-kind rule is the oldest
 * face of this; the same signal now gates all three.
 *
 * An *unloaded* transcript is not an empty one. `useMessagesQuery` answers
 * `undefined` both for a chat with no turns and for one whose turns have not
 * arrived yet, and reading the second as the first would let an existing
 * chat's identity change in place — the one thing the lock exists to prevent.
 * So an existing chat counts as having turns until its transcript says
 * otherwise. A chat that has no id yet has no turns by construction, and its
 * query never runs.
 */
export function useChatHasTurns(chatId: string | null): boolean {
  const { data: transcriptIsEmpty } = useMessagesQuery(chatId, selectTranscriptIsEmpty);
  return chatId ? transcriptIsEmpty !== true : false;
}
