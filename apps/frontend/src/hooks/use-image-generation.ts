/* global console */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@mangostudio/shared';
import { messageKeys } from './use-messages-query';
import { galleryKeys } from './use-gallery-query';
import { generateImage, uploadReferenceImage } from '../services/generation-service';
import { useI18n } from './use-i18n';
import type { useOptimisticMessages } from './use-optimistic-messages';
import type { useChats } from './use-chats';
import type { useGlobalSettings } from './use-global-settings';

interface UseImageGenerationOptions {
  chats: ReturnType<typeof useChats>;
  getActiveModel: () => string;
  settings: ReturnType<typeof useGlobalSettings>;
  optimistic: ReturnType<typeof useOptimisticMessages>;
}

/** Handles image generation — upload reference, call API, optimistic UI. */
export function useImageGeneration({
  chats,
  getActiveModel,
  settings,
  optimistic,
}: UseImageGenerationOptions) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);

  const { appendOptimisticMessages, replaceOptimisticMessages, updateOptimisticMessage } =
    optimistic;

  const handleGenerate = useCallback(
    async (prompt: string, referenceImage?: File | null) => {
      if (isGenerating) return;
      setIsGenerating(true);

      let activeChatId = chats.currentChatId;
      if (!activeChatId) {
        const newChat = await chats.createChat(
          prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '')
        );
        activeChatId = newChat.id;
      }

      const model = getActiveModel();

      // Create the preview URL synchronously before showing optimistic messages
      const previewUrl = referenceImage ? URL.createObjectURL(referenceImage) : null;

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

      // Upload reference image after showing optimistic messages so failures are visible
      let refImageUrl: string | null = null;
      if (referenceImage) {
        refImageUrl = await uploadReferenceImage(referenceImage);
        if (!refImageUrl) {
          updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
            isGenerating: false,
            text: t.errors.referenceImageUploadFailed,
          });
          setIsGenerating(false);
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          return;
        }
      }

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
        const errorText = error instanceof Error ? error.message : t.errors.imageGenerationFailed;
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
      t,
      isGenerating,
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

  return { isGenerating, handleGenerate };
}
