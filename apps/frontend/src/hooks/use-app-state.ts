import { useState, useCallback, useMemo, useEffect } from 'react';
import type { ProviderType } from '@mangostudio/shared';
import { useNavigate } from '@tanstack/react-router';
import { useChats } from '@/features/chat/hooks/use-chats';
import { useModelCatalog } from './use-model-catalog';
import { useGlobalSettings } from './use-global-settings';
import { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import { useTextGeneration } from '@/features/generation/hooks/use-text-generation';
import { useProviderSettings } from '@/features/settings/providers/hooks/use-provider-settings';
import { resolveActiveModeModel } from '@/utils/model-utils';

export function useAppState() {
  const [imageToolIntent, setImageToolIntent] = useState(false);

  const chats = useChats();
  const catalog = useModelCatalog();
  const settings = useGlobalSettings();
  const navigate = useNavigate();
  const optimistic = useOptimisticMessages();

  const activeModels = useMemo(() => catalog.catalog.textModels, [catalog.catalog.textModels]);
  const currentChat = useMemo(
    () => chats.chats.find((chat) => chat.id === chats.currentChatId) ?? null,
    [chats.chats, chats.currentChatId]
  );

  const activeModel = useMemo(
    () => resolveActiveModeModel(currentChat?.textModel, undefined, activeModels),
    [activeModels, currentChat?.textModel]
  );
  const getActiveModel = useCallback(() => activeModel, [activeModel]);
  const isModelSelectorDisabled = catalog.catalog.status !== 'ready' || activeModels.length === 0;

  const lockedProvider = useMemo((): ProviderType | null => {
    if (!currentChat?.textModel) return null;
    const modelOption = activeModels.find((model) => model.modelId === currentChat.textModel);
    return modelOption?.provider ?? null;
  }, [activeModels, currentChat?.textModel]);

  // Load provider settings for the locked provider to override global defaults
  const { descriptor: providerDescriptor } = useProviderSettings(lockedProvider);

  const effectiveThinkingEnabled =
    providerDescriptor?.settings.thinkingEnabled ?? settings.thinkingEnabled;
  const effectiveReasoningEffort =
    providerDescriptor?.settings.reasoningEffort ?? settings.reasoningEffort;
  const effectiveMaxToolIterations =
    providerDescriptor?.settings.maxToolIterations ?? settings.maxToolIterations;

  const textGen = useTextGeneration({
    chats,
    getActiveModel,
    systemPrompt: settings.globalTextSystemPrompt,
    promptSettings: settings.promptSettings,
    optimistic,
    thinkingEnabled: effectiveThinkingEnabled,
    reasoningEffort: effectiveReasoningEffort,
    maxToolIterations: effectiveMaxToolIterations,
    contextSettings: settings.contextSettings,
    chatTitleSettings: settings.chatTitleSettings,
    currentChatId: chats.currentChatId,
  });

  const chatsList = chats.chats;
  const { seedContextInfo } = textGen;
  useEffect(() => {
    for (const chat of chatsList) {
      if ('contextInfo' in chat && chat.contextInfo) {
        seedContextInfo(chat.id, chat.contextInfo);
      }
    }
  }, [chatsList, seedContextInfo]);

  const isGenerating = textGen.isGenerating;

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
    (page: 'chat' | 'gallery' | 'settings' | 'studio') => {
      const routes = {
        chat: '/',
        gallery: '/gallery',
        settings: '/settings',
        studio: '/studio',
      } as const;
      void navigate({ to: routes[page] });
    },
    [navigate]
  );

  const { handleRespond } = textGen;

  const handleSubmit = useCallback(
    (prompt: string) => {
      const intent = imageToolIntent ? ('image_generation_requested' as const) : undefined;
      void handleRespond(prompt, intent);
      setImageToolIntent(false);
    },
    [handleRespond, imageToolIntent]
  );

  return {
    imageToolIntent,
    isGenerating,
    chats: chats.chats,
    currentChatId: chats.currentChatId,
    catalog: catalog.catalog,
    settings,
    activeModels,
    activeModel,
    isModelSelectorDisabled,
    contextInfo: textGen.contextInfo,
    fallbackNotice: textGen.fallbackNotice,
    seedContextInfo: textGen.seedContextInfo,
    contextCache: textGen.contextCache,
    isContextActionPending: textGen.isContextActionPending,
    lockedProvider,

    setImageToolIntent,
    handleNewChat,
    handleUpdateChatModel,
    handleUpdateChatTitle,
    handleDeleteChat,
    handleSelectChat,
    handleNavigate,
    handleSubmit,
    handleStop: () => {
      textGen.handleStop();
      setImageToolIntent(false);
    },
    handleCompactCurrentChat: textGen.handleCompactCurrentChat,
    handleStartSummarizedChat: textGen.handleStartSummarizedChat,
    refreshCatalog: catalog.refreshCatalog,
  };
}
