import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { useChats } from '@/features/chat/hooks/use-chats';

export type AppPage = 'chat' | 'environments' | 'gallery' | 'settings' | 'studio';

interface UseChatRouteActionsParams {
  readonly chats: ReturnType<typeof useChats>;
  readonly navigate: ReturnType<typeof useNavigate>;
}

export function useChatRouteActions({ chats, navigate }: UseChatRouteActionsParams) {
  const handleNewChat = useCallback(async () => {
    await chats.createChat();
    await navigate({ to: '/' });
  }, [chats, navigate]);

  /**
   * A chat that starts on a chosen runner.
   *
   * The runner is written against the id `createChat` just returned, never
   * through the selector: that one persists against whatever chat is
   * *currently* selected, and React has not observed the new one yet when this
   * resolves — so routing it that way would rewrite the runner of the chat the
   * user just left.
   */
  const handleNewChatWithRunner = useCallback(
    async (runner: ChatRunnerConfiguration) => {
      const chat = await chats.createChat();
      await chats.updateChatRunner(chat.id, runner);
      await navigate({ to: '/' });
    },
    [chats, navigate]
  );

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
        settings: '/settings',
        studio: '/studio',
      } as const;
      void navigate({ to: routes[page] });
    },
    [navigate]
  );

  return {
    handleNewChat,
    handleNewChatWithRunner,
    handleUpdateChatModel,
    handleSelectChat,
    handleUpdateChatTitle,
    handleDeleteChat,
    handleNavigate,
  };
}
