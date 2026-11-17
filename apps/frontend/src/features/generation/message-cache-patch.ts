import type { Message } from '@mangostudio/shared/chat';

import type { MessagesCache } from '@/features/chat/transcript-pages';

/**
 * Merges `updates` into the one message `messageId` names, keeping the identity
 * of everything the patch does not touch.
 *
 * A streamed turn patches the same row once per chunk. Only the page holding
 * that row, its `messages` array and the row itself are new objects, so the
 * other pages and every other row keep their reference and a memoized row
 * above the live one is skipped instead of re-rendered. A cache that does not
 * hold the id comes back as the same object.
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
