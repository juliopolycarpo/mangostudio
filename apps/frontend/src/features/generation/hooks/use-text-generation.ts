/* global console */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Message, MessagePart } from '@mangostudio/shared';
import { messageKeys } from '@/features/chat/queries';
import { respondTextStream } from '@/services/generation-service';
import { useChatStream } from '@/features/chat/hooks/use-chat-stream';
import type { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import type { useChats } from '@/features/chat/hooks/use-chats';

interface UseTextGenerationOptions {
  chats: ReturnType<typeof useChats>;
  getActiveModel: () => string;
  systemPrompt: string;
  optimistic: ReturnType<typeof useOptimisticMessages>;
  thinkingEnabled: boolean;
  reasoningEffort: string;
  maxToolIterations: number;
  currentChatId: string | null;
}

/** Handles text generation: creates messages, drives SSE stream, updates optimistic UI. */
export function useTextGeneration({
  chats,
  getActiveModel,
  systemPrompt,
  optimistic,
  thinkingEnabled,
  reasoningEffort,
  maxToolIterations,
  currentChatId,
}: UseTextGenerationOptions) {
  const queryClient = useQueryClient();
  const stream = useChatStream({ currentChatId });
  const { appendOptimisticMessages, updateOptimisticMessage } = optimistic;

  const handleRespond = useCallback(
    async (prompt: string) => {
      if (stream.abortControllerRef.current) return;
      stream.setIsGenerating(true);

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
        chatId: activeChatId,
        role: 'user',
        text: prompt,
        timestamp: Date.now(),
        interactionMode: 'chat',
      };

      const optimisticAiMsg: Message = {
        id: optimisticAiMsgId,
        chatId: activeChatId,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: true,
        modelName: model,
        interactionMode: 'chat',
      };

      appendOptimisticMessages(activeChatId, [optimisticUserMsg, optimisticAiMsg]);

      const controller = new AbortController();
      stream.abortControllerRef.current = controller;
      let accumulatedText = '';
      const thinkingSegments: string[] = [];
      let currentThinkingIdx = -1;
      let accumulatedParts: MessagePart[] = [];

      try {
        await respondTextStream(
          {
            chatId: activeChatId,
            prompt,
            model,
            systemPrompt: systemPrompt || undefined,
            thinkingEnabled,
            reasoningEffort,
            maxToolIterations,
          },
          (chunk) => {
            switch (chunk.type) {
              case 'error':
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  isGenerating: false,
                  text: accumulatedText || chunk.error,
                  parts: [...accumulatedParts, { type: 'error', text: chunk.error }],
                });
                break;
              case 'thinking_start':
                thinkingSegments.push('');
                currentThinkingIdx = thinkingSegments.length - 1;
                accumulatedParts = [...accumulatedParts, { type: 'thinking', text: '' }];
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              case 'thinking': {
                if (currentThinkingIdx < 0) {
                  thinkingSegments.push('');
                  currentThinkingIdx = thinkingSegments.length - 1;
                  accumulatedParts = [...accumulatedParts, { type: 'thinking', text: '' }];
                }
                thinkingSegments[currentThinkingIdx] += chunk.text;
                let foundLast = false;
                accumulatedParts = accumulatedParts
                  .slice()
                  .reverse()
                  .map((p) => {
                    if (!foundLast && p.type === 'thinking') {
                      foundLast = true;
                      return {
                        type: 'thinking' as const,
                        text: thinkingSegments[currentThinkingIdx],
                      };
                    }
                    return p;
                  })
                  .reverse();
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'text':
                currentThinkingIdx = -1;
                accumulatedText += chunk.text;
                accumulatedParts = [
                  ...accumulatedParts.filter((p) => p.type !== 'text'),
                  { type: 'text', text: accumulatedText },
                ];
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  text: accumulatedText,
                  parts: accumulatedParts,
                });
                break;
              case 'tool_call_started': {
                currentThinkingIdx = -1;
                const toolCallPart: MessagePart = {
                  type: 'tool_call',
                  toolCallId: chunk.callId,
                  name: chunk.name,
                  args: {},
                };
                accumulatedParts = [...accumulatedParts, toolCallPart];
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'tool_call_completed': {
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = JSON.parse(chunk.arguments) as Record<string, unknown>;
                } catch {
                  // Keep empty args
                }
                accumulatedParts = accumulatedParts.map((p) =>
                  p.type === 'tool_call' && p.toolCallId === chunk.callId
                    ? { ...p, args: parsedArgs }
                    : p
                );
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'tool_result': {
                const resultPart: MessagePart = {
                  type: 'tool_result',
                  toolCallId: chunk.callId,
                  content: JSON.stringify(chunk.result),
                  isError: chunk.isError,
                };
                accumulatedParts = [...accumulatedParts, resultPart];
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'context_info':
                stream.updateContextInfo(activeChatId, {
                  estimatedInputTokens: chunk.estimatedInputTokens,
                  contextLimit: chunk.contextLimit,
                  estimatedUsageRatio: chunk.estimatedUsageRatio,
                  mode: chunk.mode,
                  severity: chunk.severity,
                });
                break;
              case 'fallback_notice':
                stream.setFallbackNotice({ from: chunk.from, to: chunk.to, reason: chunk.reason });
                break;
              case 'system_event': {
                accumulatedParts = [
                  ...accumulatedParts,
                  { type: 'system_event', event: chunk.event, detail: chunk.detail },
                ];
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'done':
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  isGenerating: false,
                  text: accumulatedText,
                  parts: [...accumulatedParts],
                  generationTime: chunk.generationTime,
                });
                break;
              default: {
                const _exhaustive: never = chunk;
                return _exhaustive;
              }
            }
          },
          controller.signal
        );
      } catch (error: unknown) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          updateOptimisticMessage(activeChatId, optimisticAiMsgId, { isGenerating: false });
        } else {
          console.error('[respond]', error);
          const errorText =
            error instanceof Error ? error.message : 'Failed to get a response. Please try again.';
          const alreadyHasError = accumulatedParts.some((p) => p.type === 'error');
          const nextParts: MessagePart[] = alreadyHasError
            ? accumulatedParts
            : [...accumulatedParts, { type: 'error', text: errorText }];
          updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
            isGenerating: false,
            text: accumulatedText || errorText,
            parts: nextParts,
          });
        }
      } finally {
        stream.abortControllerRef.current = null;
        stream.setIsGenerating(false);
        void chats.loadChats();
        void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId) });
      }
    },
    [
      chats,
      getActiveModel,
      systemPrompt,
      appendOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
      thinkingEnabled,
      reasoningEffort,
      maxToolIterations,
      stream,
    ]
  );

  return {
    isGenerating: stream.isGenerating,
    handleRespond,
    handleStop: stream.handleStop,
    contextInfo: stream.contextInfo,
    fallbackNotice: stream.fallbackNotice,
    seedContextInfo: stream.seedContextInfo,
    contextCache: stream.contextCache,
  };
}
