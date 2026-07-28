import type { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { useChats } from '@/features/chat/hooks/use-chats';

export type AppPage = 'chat' | 'environments' | 'gallery' | 'library' | 'settings' | 'studio';

interface UseChatRouteActionsParams {
  readonly chats: ReturnType<typeof useChats>;
  readonly navigate: ReturnType<typeof useNavigate>;
}

export function useChatRouteActions({ chats, navigate }: UseChatRouteActionsParams) {
  const handleNewChat = useCallback(async () => {
    await chats.createChat();
    await navigate({ to: '/' });
  }, [chats, navigate]);

  const handleUpdateChatModel = useCallback(
    async (chatId: string, model: string) => {
      await chats.updateChatModel(chatId, 'textModel', model);
    },
    [chats]
  );

  const handleSelectChat = useCallback(
    (chatId: string) => {
      chats.selectChat(chatId);
      void navigate({ to: '/' });
    },
    [chats, navigate]
  );

  const handleUpdateChatTitle = useCallback(
    async (chatId: string, title: string) => {
      await chats.updateChatTitle(chatId, title);
    },
    [chats]
  );

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      await chats.deleteChat(chatId);
    },
    [chats]
  );

  const handleNavigate = useCallback(
    (page: AppPage) => {
      const routes = {
        chat: '/',
        environments: '/environments',
        gallery: '/gallery',
        library: '/library',
        settings: '/settings',
        studio: '/studio',
      } as const;
      void navigate({ to: routes[page] });
    },
    [navigate]
  );

  return {
    handleNewChat,
    handleUpdateChatModel,
    handleSelectChat,
    handleUpdateChatTitle,
    handleDeleteChat,
    handleNavigate,
  };
}
