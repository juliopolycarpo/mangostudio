import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from '../lib/api-client';
import type { Message } from '@mangostudio/shared';

export const messageKeys = {
  all: ['messages'] as const,
  lists: () => [...messageKeys.all, 'list'] as const,
  list: (chatId: string) => [...messageKeys.lists(), chatId] as const,
};

export function useMessagesQuery(chatId: string | null) {
  return useInfiniteQuery({
    queryKey: messageKeys.list(chatId!),
    queryFn: async ({ pageParam }) => {
      const query = pageParam ? { cursor: pageParam, limit: '50' } : { limit: '50' };
      const { data, error } = await client.api.chats[chatId!].messages.get({ query });
      if (error) throw new Error(error.value as unknown as string);
      return data as { messages: Message[]; nextCursor: string | null };
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
      const { data, error } = await client.api.messages.post(newMessage);
      if (error) throw new Error(error.value as unknown as string);
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
      updates: Partial<Message>;
    }) => {
      const { data, error } = await client.api.messages[id].put(updates);
      if (error) throw new Error(error.value as unknown as string);
      return data;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.list(variables.chatId) });
    },
  });
}
