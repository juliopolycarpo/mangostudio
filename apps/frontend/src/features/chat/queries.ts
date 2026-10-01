import type { Chat, UpdateChatBody } from '@mangostudio/shared';
import type { MessagesPage } from '@mangostudio/shared/chat';
import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import {
  infiniteQueryOptions,
  type Query,
  type QueryClient,
  type QueryPersister,
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
import { catchUpNewestPages, loadOlderPage, type MessagesCache } from './transcript-pages';
import { takeBackgroundRun } from './transcript-read-ahead';

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
    // A shell bootstrap query: once refused, it is asked again by the bootstrap
    // panel's retry, not by whichever component mounts next — that would retry
    // a rate-limited request on every mount. See `features/bootstrap`.
    retryOnMount: false,
    queryFn: async () => {
      const { data, error } = await client.api.chats.get();
      if (error) throw new ApiError(error.value);
      return data as ChatWithContext[];
    },
  });

/**
 * Applies a mutation's result to every cached chat list that holds one.
 *
 * A list that never loaded is left alone: seeding it from `[]` would turn a
 * refused chat list into a successful one holding only the chat just touched —
 * hiding every other chat and the bootstrap panel that offers the retry.
 */
function updateChatListCache(
  queryClient: QueryClient,
  updater: (current: ReadonlyArray<ChatWithContext>) => Array<ChatWithContext>
) {
  queryClient.setQueriesData<ReadonlyArray<ChatWithContext>>(
    { queryKey: chatKeys.lists() },
    (current) => (current === undefined ? undefined : updater(current))
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

export const messageKeys = {
  all: ['messages'] as const,
  lists: () => [...messageKeys.all, 'list'] as const,
  list: (chatId: string) => [...messageKeys.lists(), chatId] as const,
};

const MESSAGES_PAGE_SIZE = '50';

/**
 * Reads one transcript page from the newest end: the newest page for a `null`
 * cursor, otherwise the page of rows before `cursor`. Rows inside a page are
 * chronological.
 */
async function fetchMessagesPage(
  chatId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<MessagesPage> {
  const query = cursor
    ? { limit: MESSAGES_PAGE_SIZE, order: 'desc' as const, cursor }
    : { limit: MESSAGES_PAGE_SIZE, order: 'desc' as const };
  const { data, error } = await client.api
    .chats({ id: chatId })
    .messages.get(signal ? { query, fetch: { signal } } : { query });
  if (error) throw new ApiError(error.value);
  return data satisfies MessagesPage;
}

/**
 * Bounds what a re-read of the transcript costs.
 *
 * TanStack re-reads every loaded page of an infinite query on each refetch, so
 * a reader who scrolled back a long way would pay one request per page on every
 * turn. Only the newest end ever changes, so a refetch (anything that is not
 * "load the next page") reads the newest page and a page behind it, and keeps
 * the older pages as loaded; see `catchUpNewestPages`. `maxPages` was not used
 * instead: it drops the page at the opposite end from the one being fetched,
 * which here is the newest, the one live writers append to.
 *
 * "Load the next page" is read here too (see `loadOlderPage`): the page lands
 * on the cache as it is by then, so a row a live writer added meanwhile is not
 * overwritten, and a read-ahead fetch can be aborted without an error state.
 *
 * `persister` is the one hook that wraps a whole infinite fetch. Its type
 * describes a single-page query, but for an infinite one it is handed the
 * stock fetch of every page and returns the whole cache entry, hence the cast.
 */
const boundedTranscriptRefetch = (chatId: string) =>
  (async (fetchEveryPage: () => Promise<MessagesCache>, _context: unknown, query: Query) => {
    const readCache = () => query.state.data as MessagesCache | undefined;
    const loadingOlder = query.state.fetchMeta?.fetchMore !== undefined;
    if (loadingOlder) {
      const background = takeBackgroundRun(query);
      return await loadOlderPage(
        readCache,
        (cursor, signal) => fetchMessagesPage(chatId, cursor, signal),
        background && {
          signal: background.controller.signal,
          onFailure: () => {
            background.failed = true;
          },
        }
      );
    }
    const current = readCache();
    if (!current || current.pages.length < 2) return fetchEveryPage();
    return await catchUpNewestPages(current, (cursor) => fetchMessagesPage(chatId, cursor));
  }) as unknown as QueryPersister<MessagesPage, ReturnType<typeof messageKeys.list>, string | null>;

/**
 * The transcript, read from its newest end. `pages[0]` is the newest page and
 * `getNextPageParam` walks to OLDER pages (see `MessagesCache`).
 */
export const messagesQueryOptions = (chatId: string) =>
  infiniteQueryOptions({
    queryKey: messageKeys.list(chatId),
    queryFn: ({ pageParam }: { pageParam: string | null }) => fetchMessagesPage(chatId, pageParam),
    persister: boundedTranscriptRefetch(chatId),
    // A persister makes TanStack default to `offlineFirst`; keep the default
    // this query always had, so an offline tab waits instead of failing.
    networkMode: 'online',
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
