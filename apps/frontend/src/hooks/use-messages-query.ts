import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from '../lib/api-client';
import { extractApiError } from '../lib/utils';
import type { Message, UpdateMessageBody } from '@mangostudio/shared';
import type { ContextInfo } from './use-text-chat';

export type MessagesPage = {
  messages: Message[];
  nextCursor: string | null;
  contextInfo?: ContextInfo | null;
};

export const messageKeys = {
  all: ['messages'] as const,
  lists: () => [...messageKeys.all, 'list'] as const,
  list: (chatId: string) => [...messageKeys.lists(), chatId] as const,
};

export function useMessagesQuery(chatId: string | null) {
  const id = chatId ?? '';
  return useInfiniteQuery({
    queryKey: messageKeys.list(id),
    queryFn: async ({ pageParam }) => {
      const query = pageParam ? { cursor: pageParam, limit: '50' } : { limit: '50' };
      const { data, error } = await client.api.chats({ id }).messages.get({ query });
      if (error) throw new Error(extractApiError(error.value));
      return data as unknown as MessagesPage;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!chatId,
  });
}

export function useCreateMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newMessage: Message) => {
      // The API expects timestamp as a Unix epoch number; Message.timestamp is a Date object.
      const { data, error } = await client.api.messages.post({
        ...newMessage,
        timestamp: newMessage.timestamp.getTime(),
      });
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.list(variables.chatId) });
      // Also invalidate chats to update the 'updatedAt' field
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useUpdateMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      chatId: _chatId,
      updates,
    }: {
      id: string;
      chatId: string;
      updates: UpdateMessageBody;
    }) => {
      const { data, error } = await client.api.messages({ id }).put(updates);
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.list(variables.chatId) });
    },
  });
}
