import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';
import type { Chat, UpdateChatBody, Message, UpdateMessageBody } from '@mangostudio/shared';
import type { ContextInfo } from '@/features/generation/types';

// ---------------------------------------------------------------------------
// Chat query keys
// ---------------------------------------------------------------------------

export const chatKeys = {
  all: ['chats'] as const,
  lists: () => [...chatKeys.all, 'list'] as const,
  list: (filters: string) => [...chatKeys.lists(), { filters }] as const,
  details: () => [...chatKeys.all, 'detail'] as const,
  detail: (id: string) => [...chatKeys.details(), id] as const,
};

/** Chat with optional context snapshot from persisted provider state. */
export type ChatWithContext = Chat & { contextInfo?: ContextInfo | null };

export function useChatsQuery() {
  return useQuery({
    queryKey: chatKeys.lists(),
    queryFn: async () => {
      const { data, error } = await client.api.chats.get();
      if (error) throw new Error(extractApiError(error.value));
      return data as ChatWithContext[];
    },
  });
}

export function useCreateChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newChat: { title: string; model?: string }) => {
      const { data, error } = await client.api.chats.post(newChat);
      if (error) throw new Error(extractApiError(error.value));
      return data as Chat;
    },
    onSuccess: (chat) => {
      queryClient.setQueryData(chatKeys.detail(chat.id), chat);
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
    },
  });
}

export function useUpdateChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UpdateChatBody }) => {
      const { data, error } = await client.api.chats({ id }).put(updates);
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(variables.id) });
    },
  });
}

export function useDeleteChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await client.api.chats({ id }).delete();
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
    },
  });
}

// ---------------------------------------------------------------------------
// Message query keys
// ---------------------------------------------------------------------------

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
      const { data, error } = await client.api.messages.post({
        ...newMessage,
        timestamp: newMessage.timestamp.getTime(),
      });
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.list(variables.chatId) });
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
