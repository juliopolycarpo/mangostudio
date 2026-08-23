/**
 * Client-side session filter, shared by the sidebar search box and the ⌘K
 * palette's sessions source. The whole list is already in the query cache, so
 * filtering is a pure pass over it.
 */

import type { Chat } from '@mangostudio/shared';
import { workdirBasename } from '@/lib/paths';

/**
 * Everything a session can be found by, as one haystack: its title, its workdir
 * basename and its harness label.
 *
 * One definition rather than two because the sidebar filters on it while the
 * palette ranks on it, and a folder you can search for in one place but not the
 * other is the kind of gap nobody reports.
 *
 * The parts are newline-joined precisely so joining changes nothing: a search
 * box cannot produce a newline, so no query can match across the boundary and
 * the per-field semantics survive intact.
 */
export function chatSearchText(chat: Chat, runnerLabel: (chat: Chat) => string): string {
  return [chat.title, workdirBasename(chat.workdir) ?? '', runnerLabel(chat)].join('\n');
}

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
  return chats.filter((chat) => chatSearchText(chat, runnerLabel).toLowerCase().includes(needle));
}
