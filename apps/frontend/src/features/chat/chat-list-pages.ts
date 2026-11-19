import type { Chat, ChatListPage } from '@mangostudio/shared/chat';
import type { InfiniteData } from '@tanstack/react-query';

import type { ContextInfo } from '@/features/generation/types';

/** Chat with optional context snapshot from persisted provider state. */
export type ChatWithContext = Chat & { contextInfo?: ContextInfo | null };

/**
 * The shape of the chat list's cache entry.
 *
 * `pages[0]` is the newest page and every later page is older; the page param
 * of a page is the cursor that fetched it, `null` for the first. A cursor
 * names a position in the list order, not a row count, so a chat added to or
 * removed from a loaded page leaves every other page's cursor valid. That is
 * what lets the helpers below edit pages in place without refetching.
 */
export type ChatListCache = InfiniteData<ChatListPage, string | null>;

/**
 * The loaded chats as one list, newest first.
 *
 * A chat that two pages both carry (a refetch that straddles a recency bump can
 * serve one) appears once, at its first and so newest position.
 *
 * @example flattenChatPages(cache).map((chat) => chat.id) // ['a', 'b', 'c']
 */
export function flattenChatPages(cache: ChatListCache): ChatWithContext[] {
  const seen = new Set<string>();
  const chats: ChatWithContext[] = [];
  for (const page of cache.pages) {
    for (const chat of page.items) {
      if (seen.has(chat.id)) continue;
      seen.add(chat.id);
      chats.push(chat);
    }
  }
  return chats;
}

/**
 * What a list view needs to ask for the chats it has not loaded: the sidebar
 * scrolls into them, and a search has to read all of them before it can say
 * nothing matches.
 */
export interface ChatPaging {
  /** A page follows the last one loaded. */
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  /** The last request for another page failed; asking again is the reader's call. */
  readonly loadFailed: boolean;
  /** Reads the next page; a no-op while one is already loading or none remains. */
  readonly loadMore: () => Promise<void>;
}

/** What a view holds before a list has loaded, and in tests: nothing more to read. */
export const NO_MORE_CHATS: ChatPaging = {
  hasMore: false,
  isLoadingMore: false,
  loadFailed: false,
  loadMore: () => Promise.resolve(),
};

/**
 * The paging of an infinite chat query, read off its result. `loadMore` is a
 * no-op while a page is already loading: `fetchNextPage` cancels a read in
 * flight by default, so a second call would restart it instead of joining it.
 */
export function chatPagingOf(result: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}): ChatPaging {
  return {
    hasMore: result.hasNextPage,
    isLoadingMore: result.isFetchingNextPage,
    loadFailed: result.isFetchNextPageError,
    loadMore: async () => {
      if (!result.hasNextPage || result.isFetchingNextPage) return;
      await result.fetchNextPage();
    },
  };
}

function mapPages(
  cache: ChatListCache,
  mapItems: (items: ChatListPage['items'], pageIndex: number) => ChatListPage['items']
): ChatListCache {
  return {
    ...cache,
    pages: cache.pages.map((page, index) => ({ ...page, items: mapItems(page.items, index) })),
  };
}

/**
 * Puts a chat at the head of the first page, removing any copy of it from the
 * pages it was already on. The recency order puts a created or just-used chat
 * first; a copy left on a later page would list it twice.
 *
 * @example insertChatAtHead(cache, createdChat)
 */
export function insertChatAtHead(cache: ChatListCache, chat: Chat): ChatListCache {
  return mapPages(cache, (items, index) => {
    const others = items.filter((item) => item.id !== chat.id);
    return index === 0 ? [chat, ...others] : others;
  });
}

/**
 * Rewrites one chat where it is loaded. Answers `cache` itself when the chat is
 * not on a loaded page, so the caller can tell that nothing changed.
 *
 * @example patchChatInPages(cache, 'chat-1', (chat) => ({ ...chat, title: 'New' }))
 */
export function patchChatInPages(
  cache: ChatListCache,
  chatId: string,
  patch: (chat: ChatWithContext) => ChatWithContext
): ChatListCache {
  if (!cache.pages.some((page) => page.items.some((item) => item.id === chatId))) return cache;
  return mapPages(cache, (items) => items.map((item) => (item.id === chatId ? patch(item) : item)));
}

/**
 * Drops one chat from the loaded pages. A page left empty stays: its cursor is
 * the only way on to the page behind it.
 *
 * @example removeChatFromPages(cache, 'chat-1')
 */
export function removeChatFromPages(cache: ChatListCache, chatId: string): ChatListCache {
  return mapPages(cache, (items) => items.filter((item) => item.id !== chatId));
}
