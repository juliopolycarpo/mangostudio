import type { Message } from '@mangostudio/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { MessagesPage } from '@/features/chat/queries';
import { messageKeys } from '@/features/chat/queries';

type MessagesCache = InfiniteData<MessagesPage, string | null>;

/** Provides optimistic cache mutations for in-flight message updates. */
export function useOptimisticMessages() {
  const queryClient = useQueryClient();

  const appendOptimisticMessages = useCallback(
    (chatId: string, newMessages: Message[]) => {
      queryClient.setQueryData<MessagesCache>(messageKeys.list(chatId), (oldData) => {
        const base: MessagesCache = oldData ?? {
          pages: [{ messages: [], nextCursor: null }],
          pageParams: [null],
        };
        const firstPage = base.pages[0];
        if (!firstPage) return base;
        return {
          ...base,
          pages: [
            { ...firstPage, messages: [...firstPage.messages, ...newMessages] },
            ...base.pages.slice(1),
          ],
        };
      });
    },
    [queryClient]
  );

  const replaceOptimisticMessages = useCallback(
    (chatId: string, oldIds: string[], newMessages: Message[]) => {
      queryClient.setQueryData<MessagesCache>(messageKeys.list(chatId), (oldData) => {
        if (!oldData) {
          return {
            pages: [{ messages: newMessages, nextCursor: null }],
            pageParams: [null],
          };
        }

        const newPages = oldData.pages.map((page) => {
          const filtered = page.messages.filter((m) => !oldIds.includes(m.id));
          return {
            ...page,
            messages: page === oldData.pages[0] ? [...filtered, ...newMessages] : filtered,
          };
        });

        return { ...oldData, pages: newPages };
      });
    },
    [queryClient]
  );

  const updateOptimisticMessage = useCallback(
    (chatId: string, msgId: string, updates: Partial<Message>) => {
      queryClient.setQueryData<MessagesCache>(messageKeys.list(chatId), (oldData) => {
        if (!oldData) return oldData;

        const newPages = oldData.pages.map((page) => ({
          ...page,
          messages: page.messages.map((m) => (m.id === msgId ? { ...m, ...updates } : m)),
        }));

        return { ...oldData, pages: newPages };
      });
    },
    [queryClient]
  );

  return { appendOptimisticMessages, replaceOptimisticMessages, updateOptimisticMessage };
}
