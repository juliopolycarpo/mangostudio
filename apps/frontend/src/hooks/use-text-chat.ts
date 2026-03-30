/* global console */
import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@mangostudio/shared';
import { messageKeys } from './use-messages-query';
import { respondTextStream } from '../services/generation-service';
import type { useOptimisticMessages } from './use-optimistic-messages';
import type { useChats } from './use-chats';

interface UseTextChatOptions {
  chats: ReturnType<typeof useChats>;
  getActiveModel: () => string;
  systemPrompt: string;
  optimistic: ReturnType<typeof useOptimisticMessages>;
}

/** Handles text chat streaming — send prompt, manage SSE stream, optimistic UI. */
export function useTextChat({
  chats,
  getActiveModel,
  systemPrompt,
  optimistic,
}: UseTextChatOptions) {
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const { appendOptimisticMessages, updateOptimisticMessage } = optimistic;

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const handleRespond = useCallback(
    async (prompt: string) => {
      if (abortControllerRef.current) return;
      setIsGenerating(true);

      let activeChatId = chats.currentChatId;
      if (!activeChatId) {
        const newChat = await chats.createChat(
          prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '')
        );
        activeChatId = newChat.id;
      }

      const model = getActiveModel();

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
            systemPrompt: systemPrompt || undefined,
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
      systemPrompt,
      appendOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
    ]
  );

  return { isGenerating, handleRespond, handleStop };
}
