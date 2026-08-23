/**
 * Client-side session filter, shared by the sidebar search box and (next) the
 * ⌘K palette's sessions source. The whole list is already in the query cache,
 * so filtering is a pure pass over it.
 */

import type { Chat } from '@mangostudio/shared';
import { workdirBasename } from '@/lib/paths';

/**
 * Matches a chat when the query appears in its title, its workdir basename or
 * its runner label. Whitespace-only queries match everything.
 */
export function filterChats(
  chats: readonly Chat[],
  query: string,
  runnerLabel: (chat: Chat) => string
): Chat[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...chats];
  return chats.filter((chat) => {
    if (chat.title.toLowerCase().includes(needle)) return true;
    if (workdirBasename(chat.workdir)?.toLowerCase().includes(needle)) return true;
    return runnerLabel(chat).toLowerCase().includes(needle);
  });
}
