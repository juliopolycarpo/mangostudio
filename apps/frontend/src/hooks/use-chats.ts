import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  useChatsQuery,
  useCreateChatMutation,
  useUpdateChatMutation,
  useDeleteChatMutation,
} from './use-chats-query';

export function useChats() {
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);

  const { data: chatsData, isLoading, error: queryError, refetch } = useChatsQuery();
  const createMutation = useCreateChatMutation();
  const updateMutation = useUpdateChatMutation();
  const deleteMutation = useDeleteChatMutation();

  const chats = useMemo(() => chatsData || [], [chatsData]);
  const error = queryError ? queryError.message : null;

  // Auto-select first chat if none selected
  useEffect(() => {
    if (chats.length > 0 && !currentChatId) {
      setCurrentChatId(chats[0].id);
    }
  }, [chats, currentChatId]);

  const loadChats = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const createChat = useCallback(
    async (title?: string) => {
      const chat = await createMutation.mutateAsync({ title: title || 'New Chat' });
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

  const currentChat = chats.find((c) => c.id === currentChatId) || null;

  return {
    chats,
    currentChatId,
    currentChat,
    isLoading,
    error,
    loadChats,
    createChat,
    updateChatModel,
    updateChatTitle,
    deleteChat,
    selectChat,
    setCurrentChatId,
  };
}
