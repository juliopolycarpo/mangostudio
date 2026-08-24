import type { ChatRunnerConfiguration, ChatRunnerPermissions } from '@mangostudio/shared/chat';
import { createTimestampChatTitle } from '@mangostudio/shared/chat';
import { useCallback, useMemo, useState } from 'react';
import {
  useChatsQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
  useUpdateChatMutation,
} from '@/features/chat/queries';

export function useChats() {
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);

  const { data: chatsData, isLoading, error: queryError, refetch } = useChatsQuery();
  const createMutation = useCreateChatMutation();
  const updateMutation = useUpdateChatMutation();
  const deleteMutation = useDeleteChatMutation();

  const chats = useMemo(() => chatsData || [], [chatsData]);
  const error = queryError ? queryError.message : null;

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

  const updateChatWorkdir = useCallback(
    async (chatId: string, workdir: string | null) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates: { workdir },
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

  const deleteChat = useCallback(
    async (chatId: string) => {
      await deleteMutation.mutateAsync(chatId);
      if (currentChatId === chatId) {
        const remainingChats = chats.filter((c) => c.id !== chatId);
        setCurrentChatId(remainingChats.length > 0 ? remainingChats[0].id : null);
      }
    },
    [deleteMutation, currentChatId, chats]
  );

  const selectChat = useCallback((chatId: string) => {
    setCurrentChatId(chatId);
  }, []);

  const currentChat = chats.find((c) => c.id === effectiveChatId) || null;

  return {
    chats,
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
    updateChatWorkdir,
    updateChatEnvironment,
    updateChatRestrictToolsToWorkdir,
    deleteChat,
    selectChat,
    setCurrentChatId,
  };
}
