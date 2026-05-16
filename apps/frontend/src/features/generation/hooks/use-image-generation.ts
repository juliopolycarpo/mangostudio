/* global console */

import type { Message } from '@mangostudio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { useChats } from '@/features/chat/hooks/use-chats';
import { galleryKeys } from '@/features/gallery/queries';
import type { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import type { useGlobalSettings } from '@/hooks/use-global-settings';
import { useI18n } from '@/hooks/use-i18n';
import { generateImage, uploadReferenceImage } from '@/services/generation-service';

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
      let createdChatDuringRequest = false;
      if (!activeChatId) {
        const newChat = await chats.createChat(
          prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '')
        );
        activeChatId = newChat.id;
        createdChatDuringRequest = true;
      }

      const model = getActiveModel();
      const previewUrl = referenceImage ? URL.createObjectURL(referenceImage) : null;

      const optimisticUserMsgId = `optimistic-user-${crypto.randomUUID()}`;
      const optimisticAiMsgId = `optimistic-ai-${crypto.randomUUID()}`;

      const optimisticUserMsg: Message = {
        id: optimisticUserMsgId,
        chatId: activeChatId,
        role: 'user',
        text: prompt,
        referenceImage: previewUrl || undefined,
        timestamp: Date.now(),
        interactionMode: 'image',
      };

      const optimisticAiMsg: Message = {
        id: optimisticAiMsgId,
        chatId: activeChatId,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: true,
        modelName: model,
        interactionMode: 'image',
      };

      appendOptimisticMessages(activeChatId, [optimisticUserMsg, optimisticAiMsg]);

      let refImageUrl: string | null = null;
      let generatedImageSucceeded = false;
      if (referenceImage) {
        refImageUrl = await uploadReferenceImage(referenceImage);
        if (!refImageUrl) {
          updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
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
          chatId: activeChatId,
          prompt,
          systemPrompt: settings.globalImageSystemPrompt || undefined,
          promptSettings: settings.promptSettings,
          referenceImageUrl: refImageUrl || undefined,
          imageQuality: settings.globalImageQuality,
          model,
        });

        replaceOptimisticMessages(
          activeChatId,
          [optimisticUserMsgId, optimisticAiMsgId],
          [
            {
              id: userMessage.id,
              chatId: userMessage.chatId,
              role: userMessage.role,
              text: userMessage.text,
              referenceImage: userMessage.referenceImage,
              timestamp: userMessage.timestamp,
              interactionMode: 'image',
            },
            {
              id: aiMessage.id,
              chatId: aiMessage.chatId,
              role: aiMessage.role,
              text: aiMessage.text,
              imageUrl: aiMessage.imageUrl,
              timestamp: aiMessage.timestamp,
              isGenerating: false,
              generationTime: aiMessage.generationTime,
              modelName: aiMessage.modelName,
              styleParams: aiMessage.styleParams,
              interactionMode: 'image',
            },
          ]
        );
        generatedImageSucceeded = true;
      } catch (error: unknown) {
        console.error('[generate]', error);
        const errorText =
          error instanceof Error ? error.message : 'Failed to generate image. Please try again.';
        updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
          isGenerating: false,
          text: errorText,
        });
      } finally {
        setIsGenerating(false);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        if (createdChatDuringRequest) {
          void chats.loadChats();
        }
        if (generatedImageSucceeded) {
          void queryClient.invalidateQueries({ queryKey: galleryKeys.lists() });
        }
      }
    },
    [
      t,
      isGenerating,
      chats,
      getActiveModel,
      settings.globalImageSystemPrompt,
      settings.promptSettings,
      settings.globalImageQuality,
      appendOptimisticMessages,
      replaceOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
    ]
  );

  return { isGenerating, handleGenerate };
}
