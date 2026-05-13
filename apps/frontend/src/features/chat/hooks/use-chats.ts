import { useState, useCallback, useMemo } from 'react';
import { createTimestampChatTitle } from '@mangostudio/shared/chat';
import {
  useChatsQuery,
  useCreateChatMutation,
  useUpdateChatMutation,
  useDeleteChatMutation,
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

  const updateChatAgentSelection = useCallback(
    async (
      chatId: string,
      updates: { lastUsedMode: 'chat' | 'agent'; selectedAgentId?: string }
    ) => {
      await updateMutation.mutateAsync({
        id: chatId,
        updates,
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
    updateChatAgentSelection,
    deleteChat,
    selectChat,
    setCurrentChatId,
  };
}
