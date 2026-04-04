import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from '../lib/api-client';
import { extractApiError } from '../lib/utils';
import type { Chat } from '@mangostudio/shared';
import type { ContextInfo } from './use-text-chat';

/** Chat with optional context snapshot from persisted provider state. */
export type ChatWithContext = Chat & { contextInfo?: ContextInfo | null };

export const chatKeys = {
  all: ['chats'] as const,
  lists: () => [...chatKeys.all, 'list'] as const,
  list: (filters: string) => [...chatKeys.lists(), { filters }] as const,
  details: () => [...chatKeys.all, 'detail'] as const,
  detail: (id: string) => [...chatKeys.details(), id] as const,
};

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
    mutationFn: async (newChat: Chat) => {
      const { data, error } = await client.api.chats.post(newChat);
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
    },
  });
}

export function useUpdateChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Chat> }) => {
      // Eden 1.4.x creates a union type for dynamic segments that have both direct handlers
      // (put/delete) and sub-resources (messages). Cast to `any` to resolve the union.
      const { data, error } = await (client.api.chats[id] as any).put(updates);
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
      const { data, error } = await (client.api.chats[id] as any).delete();
      if (error) throw new Error(extractApiError(error.value));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
    },
  });
}
