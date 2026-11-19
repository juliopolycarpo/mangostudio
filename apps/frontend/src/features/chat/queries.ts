import {
  type Chat,
  CHAT_SEARCH_MAX_LENGTH,
  type ChatListPage,
  type MessagesPage,
  PAGE_LIMIT_DEFAULT,
  type UpdateChatBody,
} from '@mangostudio/shared/chat';
import { CHATS_TOPIC } from '@mangostudio/shared/realtime';
import {
  infiniteQueryOptions,
  keepPreviousData,
  type Query,
  type QueryClient,
  type QueryPersister,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { invalidateAllGitScopes } from '@/features/workspace/hooks/use-git-state';
import { client } from '@/lib/api-client';
import { invalidateForSignal } from '@/lib/realtime/read-after-subscribe';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { ApiError } from '@/lib/utils';

import {
  type ChatListCache,
  type ChatPaging,
  chatPagingOf,
  type ChatWithContext,
  flattenChatPages,
  insertChatAtHead,
  patchChatInPages,
  removeChatFromPages,
} from './chat-list-pages';
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
  // A separate root from `lists`: a mutation's edit of the chat list must not
  // reach a search result, which holds a different set of chats.
  searches: () => [...chatKeys.all, 'search'] as const,
  search: (text: string) => [...chatKeys.searches(), text] as const,
  details: () => [...chatKeys.all, 'detail'] as const,
  detail: (id: string) => [...chatKeys.details(), id] as const,
};

export type { ChatWithContext } from './chat-list-pages';

/** Chats per request. The server's default page, spelled out so a change there is not silent here. */
const CHAT_LIST_PAGE_SIZE = PAGE_LIMIT_DEFAULT;

/** How long typing must pause before the text is sent as a search. */
const CHAT_SEARCH_DEBOUNCE_MS = 250;

/** One page of the chat list, or of the chats whose title, folder or runner contains `text`. */
async function fetchChatListPage(request: {
  cursor: string | null;
  text?: string;
  signal?: AbortSignal;
}): Promise<ChatListPage> {
  const query = {
    limit: CHAT_LIST_PAGE_SIZE,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.text ? { q: request.text } : {}),
  };
  const { data, error } = await client.api.chats.get(
    request.signal ? { query, fetch: { signal: request.signal } } : { query }
  );
  if (error) throw new ApiError(error.value);
  return data satisfies ChatListPage;
}

/**
 * The chat list, read newest first one page at a time. `pages[0]` is the
 * newest page and `getNextPageParam` walks to older ones (see `ChatListCache`).
 */
export const chatListQueryOptions = () =>
  infiniteQueryOptions({
    queryKey: chatKeys.lists(),
    // A shell bootstrap query: once refused, it is asked again by the bootstrap
    // panel's retry, not by whichever component mounts next — that would retry
    // a rate-limited request on every mount. See `features/bootstrap`.
    retryOnMount: false,
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchChatListPage({ cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

/** The matches for `text`, paged like the list; `signal` drops a search typing has outrun. */
const chatSearchQueryOptions = (text: string) =>
  infiniteQueryOptions({
    queryKey: chatKeys.search(text),
    queryFn: ({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) =>
      fetchChatListPage({ cursor: pageParam, text, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

/** What a search box shows: the matches read so far and how to read more of them. */
export interface ChatSearchResult {
  /** The matches of the last search that returned, newest first; empty for a blank text. */
  readonly chats: readonly ChatWithContext[];
  readonly paging: ChatPaging;
  /** Typing has not yet been answered: the text is waiting to be sent or the reply is. */
  readonly isPending: boolean;
  readonly isError: boolean;
}

/**
 * Searches the whole history on the hub, so a list that is paged can say what
 * matches without loading every page. Typing is debounced, and the previous
 * text's matches stay in `chats` until the next text's arrive.
 *
 * @example
 * const { chats, isPending } = useChatSearch(query);
 */
export function useChatSearch(input: string): ChatSearchResult {
  // Longer than the hub accepts would be refused, so the tail is dropped: a
  // search for the first hundred characters finds what a longer one would.
  const text = input.trim().slice(0, CHAT_SEARCH_MAX_LENGTH);
  // Starts empty, not at `text`: a hook mounted with text already in it still
  // waits out the pause, so a burst of keystrokes is one request.
  const [sent, setSent] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSent(text), CHAT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const result = useInfiniteQuery({
    ...chatSearchQueryOptions(sent),
    enabled: sent.length > 0,
    placeholderData: keepPreviousData,
    select: flattenChatPages,
  });
  const searching = text.length > 0;
  return {
    chats: searching ? (result.data ?? []) : [],
    paging: chatPagingOf(result),
    isPending: searching && (sent !== text || result.isPending || result.isPlaceholderData),
    isError: searching && sent === text && result.isError,
  };
}

/**
 * One chat by id: the open chat when it is outside the pages loaded. It shares
 * the detail entry the mutations keep current, so a chat just created or renamed
 * is served from there.
 */
export function useChatDetailQuery(chatId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: chatKeys.detail(chatId ?? ''),
    queryFn: async (): Promise<ChatWithContext> => {
      const { data, error } = await client.api.chats({ id: chatId ?? '' }).get();
      if (error) throw new ApiError(error.value);
      return data satisfies Chat;
    },
    enabled: enabled && chatId !== null,
    // A 404 means the chat is gone; asking again cannot change that.
    retry: false,
  });
}

/**
 * Applies a mutation's result to every cached chat list that holds one, and to
 * the cached searches when `searches` is set.
 *
 * A list that never loaded is left alone: seeding it from `[]` would turn a
 * refused chat list into a successful one holding only the chat just touched —
 * hiding every other chat and the bootstrap panel that offers the retry.
 */
function updateChatListCache(
  queryClient: QueryClient,
  updater: (current: ChatListCache) => ChatListCache,
  { searches = false }: { searches?: boolean } = {}
) {
  const apply = (current: ChatListCache | undefined) =>
    current === undefined ? undefined : updater(current);
  queryClient.setQueriesData<ChatListCache>({ queryKey: chatKeys.lists() }, apply);
  if (searches) {
    queryClient.setQueriesData<ChatListCache>({ queryKey: chatKeys.searches() }, apply);
  }
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
  // The chats topic is the chat list's staleness signal: a chat created, edited,
  // or moved by a turn lands there for every tab of this account, so a turn
  // finishing in another tab (or a long background turn) refreshes the row
  // here instead of leaving it stale until this tab's next mutation. Not the
  // activity topic: a git commit or a quota refresh adds a feed row and leaves
  // the list as it was. Signal only — mutation-driven cache updates above stay
  // the fast path, and a dead socket degrades to exactly the behavior before
  // this subscription.
  useRealtimeInvalidation(CHATS_TOPIC, 'chat-list', (signal) =>
    // The whole `chats` root, not just the list: a search result or an open
    // chat read by id goes stale on the same turn the list does.
    invalidateForSignal(queryClient, signal, { queryKey: chatKeys.all })
  );
  return useInfiniteQuery({ ...chatListQueryOptions(), select: flattenChatPages });
}

/**
 * The chats loaded so far, as one list, for a reader that only displays them.
 * It does not subscribe to the realtime signal or ask for more: whoever mounts
 * `useChatsQuery` (the shell) owns both.
 */
export function useLoadedChatsQuery() {
  return useInfiniteQuery({ ...chatListQueryOptions(), select: flattenChatPages });
}

export function useCreateChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newChat: { title: string; model?: string; operationId?: string }) => {
      const { data, error } = await client.api.chats.post(newChat);
      if (error) throw new ApiError(error.value);
      return data;
    },
    onSuccess: (chat) => {
      queryClient.setQueryData(chatKeys.detail(chat.id), chat);
      updateChatListCache(queryClient, (current) => insertChatAtHead(current, chat));
      // A new chat may match a cached search; which ones is the hub's to say.
      void queryClient.invalidateQueries({ queryKey: chatKeys.searches() });
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
      updateChatListCache(
        queryClient,
        (current) =>
          patchChatInPages(current, variables.id, (item) =>
            applyChatUpdates(item, variables.updates)
          ),
        { searches: true }
      );
      // The patch shows the edit at once; the refetch settles whether the chat
      // still matches the text it was found under.
      void queryClient.invalidateQueries({ queryKey: chatKeys.searches() });

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
      updateChatListCache(queryClient, (current) => removeChatFromPages(current, chatId), {
        searches: true,
      });
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

const MESSAGES_PAGE_SIZE = 50;

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
          isReaderWaiting: () => background.readerWaiting,
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

/**
 * Observes the transcript. Pass `select` when the caller needs a fact about it
 * rather than the rows: the observer then holds the selected value, and a
 * streamed reply patching the cache once per chunk re-renders the caller only
 * when that value changes.
 *
 * @example
 * const isEmpty = useMessagesQuery(chatId, (cache) => cache.pages.length === 0).data;
 */
export function useMessagesQuery(chatId: string | null): UseInfiniteQueryResult<MessagesCache>;
export function useMessagesQuery<TData>(
  chatId: string | null,
  select: (data: MessagesCache) => TData
): UseInfiniteQueryResult<TData>;
export function useMessagesQuery(chatId: string | null, select?: (data: MessagesCache) => unknown) {
  const id = chatId ?? '';
  // An absent `select` is the query's own identity default, so the unselected
  // overload returns the cache exactly as before.
  return useInfiniteQuery({ ...messagesQueryOptions(id), enabled: !!chatId, select });
}
