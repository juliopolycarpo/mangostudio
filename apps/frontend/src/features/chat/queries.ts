import type { Chat, Message, UpdateChatBody } from '@mangostudio/shared';
import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
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
import { invalidateAllGitScopes } from '@/features/workspace/hooks/use-git-state';
import { client } from '@/lib/api-client';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { ApiError } from '@/lib/utils';
import { invalidateChatCapabilities } from './hooks/capability-invalidation';

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
      if (error) throw new ApiError(error.value);
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

/**
 * Mirrors the server's rule exactly: switching environments clears the workdir
 * only when the request did not supply one. Clearing it unconditionally would
 * blank a workdir the server just accepted, and the PUT returns `{ success }`
 * rather than the chat, so nothing would correct the cache.
 */
function applyChatUpdates<T extends ChatWithContext>(chat: T, updates: UpdateChatBody): T {
  const clearsWorkdir =
    updates.environmentId !== undefined &&
    updates.environmentId !== chat.environmentId &&
    updates.workdir === undefined;

  return {
    ...chat,
    ...updates,
    ...(clearsWorkdir ? { workdir: null } : {}),
  };
}

export function useChatsQuery() {
  const queryClient = useQueryClient();
  // The activity topic is the chat list's staleness signal: `chat_created` and
  // `turn_completed` land there for every tab of this account, so a turn
  // finishing in another tab (or a long background turn) refreshes the row
  // here instead of leaving it stale until this tab's next mutation. Signal
  // only — mutation-driven cache updates above stay the fast path, and a dead
  // socket degrades to exactly the behavior before this subscription.
  useRealtimeInvalidation(ACTIVITY_TOPIC, 'chat-list', async () => {
    await queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
  });
  return useQuery(chatListQueryOptions());
}

export function useCreateChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newChat: { title: string; model?: string }) => {
      const { data, error } = await client.api.chats.post(newChat);
      if (error) throw new ApiError(error.value);
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
      if (error) throw new ApiError(error.value);
      return data;
    },
    onSuccess: (_, variables) => {
      const previousEnvironmentId = queryClient.getQueryData<ChatWithContext>(
        chatKeys.detail(variables.id)
      )?.environmentId;

      queryClient.setQueryData<ChatWithContext | undefined>(
        chatKeys.detail(variables.id),
        (current) => (current ? applyChatUpdates(current, variables.updates) : current)
      );
      updateChatListCache(queryClient, (current) =>
        current.map((item) =>
          item.id === variables.id ? applyChatUpdates(item, variables.updates) : item
        )
      );

      const switchedEnvironment =
        variables.updates.environmentId !== undefined &&
        variables.updates.environmentId !== previousEnvironmentId;

      // Shell and tool eligibility now come from the selected runtime's manifest,
      // but the capability key holds only chat/model/agent and the invalidation
      // registry does not watch chat queries. Without this the inspector keeps
      // showing the previous environment's capabilities until it goes stale.
      if (switchedEnvironment) {
        void invalidateChatCapabilities(queryClient);
      }

      // A repoint is the one workspace change the hub does not announce on
      // `git:<chatId>`, and the Git keys hold nothing but the chat id — so the
      // rail and the header breadcrumb would keep the previous repository's
      // branch and dirty flag until a window focus. An environment switch counts
      // even without a new path: the same folder on another machine is another
      // repository, and `applyChatUpdates` clears the workdir outright unless
      // this request supplied one.
      if (variables.updates.workdir !== undefined || switchedEnvironment) {
        void invalidateAllGitScopes(queryClient, variables.id);
      }
    },
  });
}

export function useDeleteChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await client.api.chats({ id }).delete();
      if (error) throw new ApiError(error.value);
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
      if (error) throw new ApiError(error.value);
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
