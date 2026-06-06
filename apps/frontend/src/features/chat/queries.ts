import type { Chat, Message, UpdateChatBody } from '@mangostudio/shared';
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { ContextInfo } from '@/features/generation/types';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

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

export const chatListQueryOptions = () =>
  queryOptions({
    queryKey: chatKeys.lists(),
    queryFn: async () => {
      const { data, error } = await client.api.chats.get();
      if (error) throw new Error(extractApiError(error.value));
      return data as ChatWithContext[];
    },
  });

function updateChatListCache(
  queryClient: QueryClient,
  updater: (current: ReadonlyArray<ChatWithContext>) => Array<ChatWithContext>
) {
  queryClient.setQueriesData<ReadonlyArray<ChatWithContext>>(
    { queryKey: chatKeys.lists() },
    (current) => updater(current ?? [])
  );
}

function applyChatUpdates<T extends ChatWithContext>(chat: T, updates: UpdateChatBody): T {
  return {
    ...chat,
    ...updates,
  };
}

export function useChatsQuery() {
  return useQuery(chatListQueryOptions());
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
      updateChatListCache(queryClient, (current) => [
        chat,
        ...current.filter((item) => item.id !== chat.id),
      ]);
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
      queryClient.setQueryData<ChatWithContext | undefined>(
        chatKeys.detail(variables.id),
        (current) => (current ? applyChatUpdates(current, variables.updates) : current)
      );
      updateChatListCache(queryClient, (current) =>
        current.map((item) =>
          item.id === variables.id ? applyChatUpdates(item, variables.updates) : item
        )
      );
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
    onSuccess: (_, chatId) => {
      queryClient.removeQueries({ queryKey: chatKeys.detail(chatId), exact: true });
      updateChatListCache(queryClient, (current) => current.filter((chat) => chat.id !== chatId));
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

export const messagesQueryOptions = (chatId: string) =>
  infiniteQueryOptions({
    queryKey: messageKeys.list(chatId),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const query = pageParam ? { cursor: pageParam, limit: '50' } : { limit: '50' };
      const { data, error } = await client.api.chats({ id: chatId }).messages.get({ query });
      if (error) throw new Error(extractApiError(error.value));
      return data as unknown as MessagesPage;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

export function useMessagesQuery(chatId: string | null) {
  const id = chatId ?? '';
  return useInfiniteQuery({
    ...messagesQueryOptions(id),
    enabled: !!chatId,
  });
}
