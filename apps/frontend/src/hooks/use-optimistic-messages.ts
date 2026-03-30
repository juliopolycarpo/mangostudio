import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@mangostudio/shared';
import { messageKeys } from './use-messages-query';

/** Provides optimistic cache mutations for in-flight message updates. */
export function useOptimisticMessages() {
  const queryClient = useQueryClient();

  const appendOptimisticMessages = useCallback(
    (chatId: string, newMessages: Message[]) => {
      queryClient.setQueryData(messageKeys.list(chatId), (oldData: any) => {
        if (!oldData) return oldData;
        const firstPage = oldData.pages[0];
        return {
          ...oldData,
          pages: [
            { ...firstPage, messages: [...firstPage.messages, ...newMessages] },
            ...oldData.pages.slice(1),
          ],
        };
      });
    },
    [queryClient]
  );

  const replaceOptimisticMessages = useCallback(
    (chatId: string, oldIds: string[], newMessages: Message[]) => {
      queryClient.setQueryData(messageKeys.list(chatId), (oldData: any) => {
        if (!oldData) return oldData;

        const newPages = oldData.pages.map((page: any) => {
          const filtered = page.messages.filter((m: Message) => !oldIds.includes(m.id));
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
      queryClient.setQueryData(messageKeys.list(chatId), (oldData: any) => {
        if (!oldData) return oldData;

        const newPages = oldData.pages.map((page: any) => ({
          ...page,
          messages: page.messages.map((m: Message) => (m.id === msgId ? { ...m, ...updates } : m)),
        }));

        return { ...oldData, pages: newPages };
      });
    },
    [queryClient]
  );

  return { appendOptimisticMessages, replaceOptimisticMessages, updateOptimisticMessage };
}
