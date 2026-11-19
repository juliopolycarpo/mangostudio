import type {
  ChatRunnerConfiguration,
  ChatRunnerModelSelection,
  ChatRunnerPermissions,
} from '@mangostudio/shared/chat';
import { createTimestampChatTitle } from '@mangostudio/shared/chat';
import { useCallback, useMemo, useState } from 'react';

import {
  useChatDetailQuery,
  useChatSearch,
  useChatsQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
  useUpdateChatMutation,
} from '@/features/chat/queries';

import { chatPagingOf } from '../chat-list-pages';

export function useChats() {
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  // What the sidebar's search box holds, searched on the hub rather than over
  // the pages that happen to be loaded; blank asks for nothing.
  const [chatSearchText, setChatSearchText] = useState('');
  const chatSearch = useChatSearch(chatSearchText);

  const {
    data: chatsData,
    isLoading,
    error: queryError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = useChatsQuery();
  const createMutation = useCreateChatMutation();
  const updateMutation = useUpdateChatMutation();
  const deleteMutation = useDeleteChatMutation();

  const chats = useMemo(() => chatsData || [], [chatsData]);
  const error = queryError ? queryError.message : null;

  const chatPaging = chatPagingOf({
    hasNextPage: hasNextPage === true,
    isFetchingNextPage: isFetchingNextPage === true,
    isFetchNextPageError: isFetchNextPageError === true,
    fetchNextPage: fetchNextPage ?? (() => Promise.resolve()),
  });

  // Derive effective chat ID: explicit selection takes precedence, otherwise auto-select first.
  const effectiveChatId = currentChatId ?? (chats.length > 0 ? chats[0].id : null);

  const loadChats = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const createChat = useCallback(
    async (title?: string) => {
      const chat = await createMutation.mutateAsync({ title: title || createTimestampChatTitle() });
      setCurrentChatId(chat.id);
      return chat;
    },
    [createMutation]
  );

  const updateChatModel = useCallback(
    async (chatId: string, field: 'textModel' | 'imageModel', model: string) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { [field]: model },
      });
    },
    [updateMutation]
  );

  const updateChatTitle = useCallback(
    async (chatId: string, title: string) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { title },
      });
    },
    [updateMutation]
  );

  const updateChatRunner = useCallback(
    async (chatId: string, runner: ChatRunnerConfiguration) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { runner },
      });
    },
    [updateMutation]
  );

  /**
   * Machine and runner in one write.
   *
   * Two sequential updates would leave the chat briefly holding a remote
   * vendor on the local machine — a pairing nothing validates, and the state a
   * turn submitted in that window would dispatch on.
   */
  const updateChatRunnerOnEnvironment = useCallback(
    async (chatId: string, runner: ChatRunnerConfiguration, environmentId: string) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { runner, environmentId },
      });
    },
    [updateMutation]
  );

  const updateChatRunnerPermissions = useCallback(
    async (chatId: string, runnerPermissions: ChatRunnerPermissions) => {
      await updateMutation.mutateAsync({ id: chatId, updates: { runnerPermissions } });
    },
    [updateMutation]
  );

  const updateChatRunnerModelSelection = useCallback(
    async (chatId: string, runnerModelSelection: ChatRunnerModelSelection) => {
      await updateMutation.mutateAsync({ id: chatId, updates: { runnerModelSelection } });
    },
    [updateMutation]
  );

  const updateChatWorkdir = useCallback(
    async (chatId: string, workdir: string | null) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { workdir },
      });
    },
    [updateMutation]
  );

  /**
   * Machine and folder in one write, for the same reason
   * `updateChatRunnerOnEnvironment` bundles machine and runner: two sequential
   * updates would leave the chat briefly pointing at a folder on the machine
   * it is about to leave, a pairing nothing validates.
   */
  const updateChatWorkdirOnEnvironment = useCallback(
    async (chatId: string, workdir: string, environmentId: string) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { workdir, environmentId },
      });
    },
    [updateMutation]
  );

  const updateChatEnvironment = useCallback(
    async (chatId: string, environmentId: string) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { environmentId },
      });
    },
    [updateMutation]
  );

  const updateChatRestrictToolsToWorkdir = useCallback(
    async (chatId: string, restrictToolsToWorkdir: boolean | null) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { restrictToolsToWorkdir },
      });
    },
    [updateMutation]
  );

  /**
   * The selection is compared inside the updater, not against the
   * `currentChatId` this closure captured.
   *
   * A caller can hold a `deleteChat` from before the chat it is deleting even
   * existed — `handleNewChatWithRunner` creates a chat, binds its runner, and
   * deletes it again when the bind fails, all through the one `useChats` object
   * it captured at the start. The captured `currentChatId` is then whatever was
   * selected before creation, so the comparison misses, the doomed chat's id
   * stays selected, and `currentChat` resolves to null on a surface with chats
   * in the sidebar.
   */
  const deleteChat = useCallback(
    async (chatId: string) => {
      await deleteMutation.mutateAsync(chatId);
      setCurrentChatId((selected) => {
        if (selected !== chatId) return selected;
        const remainingChats = chats.filter((c) => c.id !== chatId);
        return remainingChats.length > 0 ? remainingChats[0].id : null;
      });
    },
    [deleteMutation, chats]
  );

  const selectChat = useCallback((chatId: string) => {
    setCurrentChatId(chatId);
  }, []);

  // The list is a window onto the history, so the chat being worked in can be
  // outside it: a search result, a link, a chat older than the pages read.
  // Navigation must not depend on the window, so that chat is read by id —
  // but only once the list has settled, because the list may be about to
  // hold it. Once a later page does, the list's own row takes over.
  const listedChat = chats.find((c) => c.id === effectiveChatId) ?? null;
  const unlistedChat = useChatDetailQuery(effectiveChatId, !isLoading && listedChat === null).data;
  const currentChat = listedChat ?? unlistedChat ?? null;
  // The sidebar shows it pinned, so the open chat is never missing from the
  // list it is highlighted in.
  const pinnedChat = listedChat === null ? (unlistedChat ?? null) : null;

  return {
    chats,
    chatPaging,
    chatSearch,
    setChatSearchText,
    pinnedChat,
    currentChatId: effectiveChatId,
    currentChat,
    isLoading,
    error,
    loadChats,
    createChat,
    updateChatModel,
    updateChatTitle,
    updateChatRunner,
    updateChatRunnerOnEnvironment,
    updateChatRunnerPermissions,
    updateChatRunnerModelSelection,
    updateChatWorkdir,
    updateChatWorkdirOnEnvironment,
    updateChatEnvironment,
    updateChatRestrictToolsToWorkdir,
    deleteChat,
    selectChat,
    setCurrentChatId,
  };
}
