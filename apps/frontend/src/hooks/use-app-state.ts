import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { InteractionMode } from '@mangostudio/shared';
import { useChats } from './use-chats';
import { useModelCatalog } from './use-model-catalog';
import { useGlobalSettings } from './use-global-settings';
import { useOptimisticMessages } from './use-optimistic-messages';
import { useTextChat } from './use-text-chat';
import { useImageGeneration } from './use-image-generation';
import { resolveActiveModeModel } from '../utils/model-utils';

export function useAppState() {
  const [composerMode, setComposerMode] = useState<InteractionMode>('chat');

  const chats = useChats();
  const catalog = useModelCatalog();
  const settings = useGlobalSettings();
  const navigate = useNavigate();

  const activeModels = useMemo(
    () => (composerMode === 'chat' ? catalog.catalog.textModels : catalog.catalog.imageModels),
    [composerMode, catalog.catalog.textModels, catalog.catalog.imageModels]
  );

  const getActiveModel = useCallback(() => {
    const currentChat = chats.chats.find((c) => c.id === chats.currentChatId);
    if (composerMode === 'chat') {
      return resolveActiveModeModel(currentChat?.textModel, undefined, catalog.catalog.textModels);
    }
    return resolveActiveModeModel(currentChat?.imageModel, undefined, catalog.catalog.imageModels);
  }, [
    chats.chats,
    chats.currentChatId,
    composerMode,
    catalog.catalog.textModels,
    catalog.catalog.imageModels,
  ]);

  const activeModel = getActiveModel();
  const isModelSelectorDisabled = catalog.catalog.status !== 'ready' || activeModels.length === 0;

  const optimistic = useOptimisticMessages();

  const textChat = useTextChat({
    chats,
    getActiveModel,
    systemPrompt: settings.globalTextSystemPrompt,
    optimistic,
  });

  const imageGen = useImageGeneration({
    chats,
    getActiveModel,
    settings,
    optimistic,
  });

  const isGenerating = textChat.isGenerating || imageGen.isGenerating;

  const handleNewChat = useCallback(async () => {
    await chats.createChat();
    await navigate({ to: '/' });
    setComposerMode('chat');
  }, [chats, navigate]);

  const handleUpdateChatModel = useCallback(
    async (chatId: string, model: string) => {
      const field = composerMode === 'chat' ? 'textModel' : 'imageModel';
      await chats.updateChatModel(chatId, field, model);
    },
    [chats, composerMode]
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
    (page: 'chat' | 'gallery' | 'settings') => {
      const routes = { chat: '/', gallery: '/gallery', settings: '/settings' } as const;
      void navigate({ to: routes[page] });
    },
    [navigate]
  );

  const handleSubmit = useCallback(
    (prompt: string, referenceImage?: File | null) => {
      if (composerMode === 'chat') return textChat.handleRespond(prompt);
      return imageGen.handleGenerate(prompt, referenceImage);
    },
    [composerMode, textChat.handleRespond, imageGen.handleGenerate]
  );

  const initialize = useCallback(async () => {
    await chats.loadChats();
    await catalog.refreshCatalog();
  }, [chats, catalog]);

  return {
    composerMode,
    isGenerating,
    chats: chats.chats,
    currentChatId: chats.currentChatId,
    catalog: catalog.catalog,
    settings,
    activeModels,
    activeModel,
    isModelSelectorDisabled,

    setComposerMode,
    handleNewChat,
    handleUpdateChatModel,
    handleUpdateChatTitle,
    handleDeleteChat,
    handleSelectChat,
    handleNavigate,
    handleSubmit,
    handleStop: textChat.handleStop,
    initialize,
    refreshCatalog: catalog.refreshCatalog,
  };
}
