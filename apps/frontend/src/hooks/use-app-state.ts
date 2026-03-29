/* global console */
import { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { InteractionMode, Message } from '@mangostudio/shared';
import { useChats } from './use-chats';
import { useGeminiCatalog } from './use-gemini-catalog';
import { useGlobalSettings } from './use-global-settings';
import { useQueryClient } from '@tanstack/react-query';
import { messageKeys } from './use-messages-query';
import { galleryKeys } from './use-gallery-query';
import { resolveActiveModeModel } from '../utils/gemini-models';
import {
  generateImage,
  respondTextStream,
  uploadReferenceImage,
} from '../services/generation-service';

export function useAppState() {
  // Core state
  const [composerMode, setComposerMode] = useState<InteractionMode>('chat');
  const [isGenerating, setIsGenerating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Sub-hooks
  const chats = useChats();
  const catalog = useGeminiCatalog();
  const settings = useGlobalSettings();
  const queryClient = useQueryClient();

  // Derived state
  const activeModels = useMemo(
    () => (composerMode === 'chat' ? catalog.catalog.textModels : catalog.catalog.imageModels),
    [composerMode, catalog.catalog.textModels, catalog.catalog.imageModels]
  );

  const getActiveModel = useCallback(() => {
    const currentChat = chats.chats.find((c) => c.id === chats.currentChatId);
    if (composerMode === 'chat') {
      return resolveActiveModeModel(
        currentChat?.textModel,
        undefined, // Removed global default
        catalog.catalog.textModels
      );
    }
    return resolveActiveModeModel(
      currentChat?.imageModel,
      undefined, // Removed global default
      catalog.catalog.imageModels
    );
  }, [
    chats.chats,
    chats.currentChatId,
    composerMode,
    catalog.catalog.textModels,
    catalog.catalog.imageModels,
  ]);

  const activeModel = getActiveModel();
  const isModelSelectorDisabled = catalog.catalog.status !== 'ready' || activeModels.length === 0;

  // Handlers
  const navigate = useNavigate();

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

  // Helper for optimistic updates
  const appendOptimisticMessages = useCallback(
    (chatId: string, newMessages: Message[]) => {
      queryClient.setQueryData(messageKeys.list(chatId), (oldData: any) => {
        if (!oldData) return oldData;
        const firstPage = oldData.pages[0];
        const updatedFirstPage = {
          ...firstPage,
          messages: [...firstPage.messages, ...newMessages],
        };
        return {
          ...oldData,
          pages: [updatedFirstPage, ...oldData.pages.slice(1)],
        };
      });
    },
    [queryClient]
  );

  const replaceOptimisticMessages = useCallback(
    (chatId: string, oldIds: string[], newMessages: Message[]) => {
      queryClient.setQueryData(messageKeys.list(chatId), (oldData: any) => {
        if (!oldData) return oldData;

        const newPages = oldData.pages.map((page: any) => {
          const filtered = page.messages.filter((m: Message) => !oldIds.includes(m.id));
          return {
            ...page,
            messages: page === oldData.pages[0] ? [...filtered, ...newMessages] : filtered,
          };
        });

        return {
          ...oldData,
          pages: newPages,
        };
      });
    },
    [queryClient]
  );

  const updateOptimisticMessage = useCallback(
    (chatId: string, msgId: string, updates: Partial<Message>) => {
      queryClient.setQueryData(messageKeys.list(chatId), (oldData: any) => {
        if (!oldData) return oldData;

        const newPages = oldData.pages.map((page: any) => ({
          ...page,
          messages: page.messages.map((m: Message) => (m.id === msgId ? { ...m, ...updates } : m)),
        }));

        return {
          ...oldData,
          pages: newPages,
        };
      });
    },
    [queryClient]
  );

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // Generation handlers
  const handleRespond = useCallback(
    async (prompt: string) => {
      setIsGenerating(true);

      let activeChatId = chats.currentChatId;
      if (!activeChatId) {
        const newChat = await chats.createChat(
          prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '')
        );
        activeChatId = newChat.id;
      }

      const model = getActiveModel();

      // Optimistic UI
      const optimisticUserMsgId = `optimistic-user-${Date.now()}`;
      const optimisticAiMsgId = `optimistic-ai-${Date.now() + 1}`;

      const optimisticUserMsg: Message = {
        id: optimisticUserMsgId,
        chatId: activeChatId!,
        role: 'user',
        text: prompt,
        timestamp: new Date(),
        interactionMode: 'chat',
      };

      const optimisticAiMsg: Message = {
        id: optimisticAiMsgId,
        chatId: activeChatId!,
        role: 'ai',
        text: '',
        timestamp: new Date(),
        isGenerating: true,
        modelName: model,
        interactionMode: 'chat',
      };

      appendOptimisticMessages(activeChatId!, [optimisticUserMsg, optimisticAiMsg]);

      const controller = new AbortController();
      abortControllerRef.current = controller;
      let accumulatedText = '';

      try {
        await respondTextStream(
          {
            chatId: activeChatId!,
            prompt,
            model,
            systemPrompt: settings.globalTextSystemPrompt || undefined,
          },
          (chunk) => {
            if (chunk.error) {
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                isGenerating: false,
                text: chunk.error,
              });
              return;
            }
            if (!chunk.done) {
              accumulatedText += chunk.text ?? '';
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                text: accumulatedText,
              });
            } else {
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                isGenerating: false,
                text: accumulatedText,
                generationTime: chunk.generationTime,
              });
            }
          },
          controller.signal
        );
      } catch (error: unknown) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          // User stopped generation — keep partial text visible
          updateOptimisticMessage(activeChatId!, optimisticAiMsgId, { isGenerating: false });
        } else {
          console.error('[respond]', error);
          const errorText =
            error instanceof Error ? error.message : 'Failed to get a response. Please try again.';
          updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
            isGenerating: false,
            text: errorText,
          });
        }
      } finally {
        abortControllerRef.current = null;
        setIsGenerating(false);
        void chats.loadChats();
        void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId!) });
      }
    },
    [
      chats,
      getActiveModel,
      settings.globalTextSystemPrompt,
      appendOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
    ]
  );

  const handleGenerate = useCallback(
    async (prompt: string, referenceImage?: File | null) => {
      setIsGenerating(true);

      let activeChatId = chats.currentChatId;
      if (!activeChatId) {
        const newChat = await chats.createChat(
          prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '')
        );
        activeChatId = newChat.id;
      }

      const model = getActiveModel();

      // Upload reference image if provided as File
      let refImageUrl: string | null = null;
      let previewUrl: string | null = null;

      if (referenceImage) {
        previewUrl = URL.createObjectURL(referenceImage);
        refImageUrl = await uploadReferenceImage(referenceImage);
      }

      // Optimistic UI
      const optimisticUserMsgId = `optimistic-user-${Date.now()}`;
      const optimisticAiMsgId = `optimistic-ai-${Date.now() + 1}`;

      const optimisticUserMsg: Message = {
        id: optimisticUserMsgId,
        chatId: activeChatId!,
        role: 'user',
        text: prompt,
        referenceImage: previewUrl || undefined,
        timestamp: new Date(),
        interactionMode: 'image',
      };

      const optimisticAiMsg: Message = {
        id: optimisticAiMsgId,
        chatId: activeChatId!,
        role: 'ai',
        text: '',
        timestamp: new Date(),
        isGenerating: true,
        modelName: model,
        interactionMode: 'image',
      };

      appendOptimisticMessages(activeChatId!, [optimisticUserMsg, optimisticAiMsg]);

      try {
        const { userMessage, aiMessage } = await generateImage({
          chatId: activeChatId!,
          prompt,
          systemPrompt: settings.globalImageSystemPrompt || undefined,
          referenceImageUrl: refImageUrl || undefined,
          imageQuality: settings.globalImageQuality,
          model,
        });

        replaceOptimisticMessages(
          activeChatId!,
          [optimisticUserMsgId, optimisticAiMsgId],
          [
            {
              id: userMessage.id,
              chatId: userMessage.chatId,
              role: userMessage.role,
              text: userMessage.text,
              referenceImage: userMessage.referenceImage,
              timestamp: new Date(userMessage.timestamp),
              interactionMode: 'image',
            },
            {
              id: aiMessage.id,
              chatId: aiMessage.chatId,
              role: aiMessage.role,
              text: aiMessage.text,
              imageUrl: aiMessage.imageUrl,
              timestamp: new Date(aiMessage.timestamp),
              isGenerating: false,
              generationTime: aiMessage.generationTime,
              modelName: aiMessage.modelName,
              styleParams: aiMessage.styleParams,
              interactionMode: 'image',
            },
          ]
        );
      } catch (error: unknown) {
        console.error('[generate]', error);
        const errorText =
          error instanceof Error ? error.message : 'Failed to generate image. Please try again.';
        updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
          isGenerating: false,
          text: errorText,
        });
      } finally {
        setIsGenerating(false);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        void chats.loadChats();
        void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId!) });
        void queryClient.invalidateQueries({ queryKey: galleryKeys.lists() });
      }
    },
    [
      chats,
      getActiveModel,
      settings.globalImageSystemPrompt,
      settings.globalImageQuality,
      appendOptimisticMessages,
      replaceOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
    ]
  );

  const handleSubmit = useCallback(
    (prompt: string, referenceImage?: File | null) => {
      if (composerMode === 'chat') {
        return handleRespond(prompt);
      }
      return handleGenerate(prompt, referenceImage);
    },
    [composerMode, handleRespond, handleGenerate]
  );

  // Initial data loading
  const initialize = useCallback(async () => {
    await chats.loadChats();
    await catalog.refreshCatalog();
  }, [chats, catalog]);

  return {
    // State
    composerMode,
    isGenerating,
    chats: chats.chats,
    currentChatId: chats.currentChatId,
    catalog: catalog.catalog,
    settings,
    activeModels,
    activeModel,
    isModelSelectorDisabled,

    // Actions
    setComposerMode,
    handleNewChat,
    handleUpdateChatModel,
    handleUpdateChatTitle,
    handleDeleteChat,
    handleSelectChat,
    handleNavigate,
    handleSubmit,
    handleStop,
    initialize,
    refreshCatalog: catalog.refreshCatalog,
  };
}
