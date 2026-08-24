import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import type { useChats } from '@/features/chat/hooks/use-chats';
import { useI18n } from '@/hooks/use-i18n';

export type AppPage = 'chat' | 'environments' | 'gallery' | 'settings' | 'studio';

interface UseChatRouteActionsParams {
  readonly chats: ReturnType<typeof useChats>;
  readonly navigate: ReturnType<typeof useNavigate>;
  /**
   * Suspends the workdir-defaulting effect while `task` runs; see
   * `handleNewChatWithRunner` for why creation cannot go unheld.
   */
  readonly holdWorkdirDefault: <T>(task: () => Promise<T>) => Promise<T>;
}

export function useChatRouteActions({
  chats,
  navigate,
  holdWorkdirDefault,
}: UseChatRouteActionsParams) {
  const { t } = useI18n();
  const { toast } = useToast();

  const handleNewChat = useCallback(async () => {
    await chats.createChat();
    await navigate({ to: '/' });
  }, [chats, navigate]);

  /**
   * A chat that starts on a chosen runner, on the machine that runner came from.
   *
   * The runner is written against the id `createChat` just returned, never
   * through the selector: that one persists against whatever chat is
   * *currently* selected, and React has not observed the new one yet when this
   * resolves — so routing it that way would rewrite the runner of the chat the
   * user just left.
   *
   * `environmentId` is not decoration. Creation always lands on `local` — the
   * create body has no machine field — while an external runner is only ever
   * offered because discovery found it on some *particular* environment. Left
   * unsaid, a vendor found on a remote box would be bound to a local chat that
   * has no such installation, and nothing server-side rejects that pairing.
   * Omit it for a runner that is machine-independent, which is every
   * MangoStudio agent profile.
   *
   * The whole sequence runs under `holdWorkdirDefault` because creation
   * publishes and selects a *local* record before the repoint resolves, and
   * the workdir-defaulting effect can observe that intermediate chat. Acting
   * on it either sends the hub's default path to a chat that is about to be
   * remote — silently the wrong project when a same-named directory exists
   * over there — or marks the id as defaulted so the repointed chat never
   * gets its picker. The hold releases once the repoint has landed in the
   * cache, so the effect's first look at the chat sees its final machine.
   *
   * The repoint can fail on its own — the environment discovery found the
   * runner on can vanish between opening the palette and running this. The
   * caller (`void item.run()` in the palette) discards that rejection, so a
   * bare throw here would leave an orphaned local chat selected with no
   * indication anything went wrong. Rolled back and reported instead, still
   * inside the hold so the defaulting effect never sees the doomed chat.
   */
  const handleNewChatWithRunner = useCallback(
    async (runner: ChatRunnerConfiguration, environmentId?: string) => {
      const bound = await holdWorkdirDefault(async () => {
        const chat = await chats.createChat();
        try {
          if (environmentId !== undefined && environmentId !== chat.environmentId) {
            await chats.updateChatRunnerOnEnvironment(chat.id, runner, environmentId);
          } else {
            await chats.updateChatRunner(chat.id, runner);
          }
          return true;
        } catch {
          await chats.deleteChat(chat.id);
          return false;
        }
      });
      if (!bound) {
        toast(t.chat.newChatRunnerFailed, 'error');
        return;
      }
      await navigate({ to: '/' });
    },
    [chats, holdWorkdirDefault, navigate, t, toast]
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
