import type { Message } from '@mangostudio/shared/chat';

import type { MessagesCache } from '@/features/chat/transcript-pages';

/**
 * Merges `updates` into the one message `messageId` names, copying only what the
 * patch touches.
 *
 * A streamed turn patches the same row once per chunk. Only the page holding
 * that row, its `messages` array and the row itself are new objects; every
 * other page and row is the same object, so the write costs one page copy
 * instead of a rebuild of the whole transcript. (Skipped renders are not the
 * gain: the query's structural sharing already hands old row objects back.) A
 * cache that does not hold the id comes back as the same object.
 *
 * Row ids are unique across the loaded pages, so only the first match is
 * patched: the newest page is searched first and each page from its end, where
 * the live row is. A duplicated id patches that one row and leaves the other.
 *
 * @example
 * queryClient.setQueryData(key, (cache) => patchMessageInCache(cache, 'msg-1', { text: 'hi' }));
 */
export function patchMessageInCache(
  cache: MessagesCache | undefined,
  messageId: string,
  updates: Partial<Message>
): MessagesCache | undefined {
  if (!cache) return cache;
  // The live row is the newest, so scanning each page from its end finds it first.
  let pageIndex = -1;
  let messageIndex = -1;
  for (let index = 0; index < cache.pages.length && messageIndex === -1; index += 1) {
    const messages = cache.pages[index]?.messages ?? [];
    for (let position = messages.length - 1; position >= 0; position -= 1) {
      if (messages[position]?.id === messageId) {
        pageIndex = index;
        messageIndex = position;
        break;
      }
    }
  }
  if (messageIndex === -1) return cache;

  const page = cache.pages[pageIndex];
  const message = page?.messages[messageIndex];
  if (!page || !message) return cache;

  const messages = page.messages.slice();
  messages[messageIndex] = { ...message, ...updates };
  const pages = cache.pages.slice();
  pages[pageIndex] = { ...page, messages };
  return { ...cache, pages };
}
