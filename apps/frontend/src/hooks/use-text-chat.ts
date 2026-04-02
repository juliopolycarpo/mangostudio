/* global console */
import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Message, MessagePart, SSEContextEvent, SSEFallbackEvent } from '@mangostudio/shared';
import { messageKeys } from './use-messages-query';
import { respondTextStream } from '../services/generation-service';
import type { useOptimisticMessages } from './use-optimistic-messages';
import type { useChats } from './use-chats';

export type ContextInfo = Pick<
  SSEContextEvent,
  'estimatedInputTokens' | 'contextLimit' | 'estimatedUsageRatio' | 'mode' | 'severity'
>;

export type FallbackNotice = Pick<SSEFallbackEvent, 'from' | 'to' | 'reason'>;

interface UseTextChatOptions {
  chats: ReturnType<typeof useChats>;
  getActiveModel: () => string;
  systemPrompt: string;
  optimistic: ReturnType<typeof useOptimisticMessages>;
  thinkingEnabled: boolean;
  reasoningEffort: string;
}

/** Handles text chat streaming — send prompt, manage SSE stream, optimistic UI. */
export function useTextChat({
  chats,
  getActiveModel,
  systemPrompt,
  optimistic,
  thinkingEnabled,
  reasoningEffort,
}: UseTextChatOptions) {
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<FallbackNotice | null>(null);
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
      let accumulatedThinking = '';
      let accumulatedParts: MessagePart[] = [];

      try {
        await respondTextStream(
          {
            chatId: activeChatId!,
            prompt,
            model,
            systemPrompt: systemPrompt || undefined,
            thinkingEnabled,
            reasoningEffort,
          },
          (chunk) => {
            if (chunk.error) {
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                isGenerating: false,
                text: accumulatedText || chunk.error,
                parts: [...accumulatedParts, { type: 'error', text: chunk.error }],
              });
              return;
            }

            const chunkType = chunk.type ?? 'text';

            if (chunkType === 'thinking' && chunk.text) {
              accumulatedThinking += chunk.text;
              const thinkingPart: MessagePart = { type: 'thinking', text: accumulatedThinking };
              accumulatedParts = [
                thinkingPart,
                ...accumulatedParts.filter((p) => p.type !== 'thinking'),
              ];
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'text' && !chunk.done && chunk.text) {
              accumulatedText += chunk.text;
              const textPart: MessagePart = { type: 'text', text: accumulatedText };
              accumulatedParts = [...accumulatedParts.filter((p) => p.type !== 'text'), textPart];
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                text: accumulatedText,
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'tool_call_started' && chunk.callId) {
              // Add a pending tool_call part for optimistic UI
              const toolCallPart: MessagePart = {
                type: 'tool_call',
                toolCallId: chunk.callId,
                name: chunk.name ?? '',
                args: {},
              };
              accumulatedParts = [...accumulatedParts, toolCallPart];
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'tool_call_completed' && chunk.callId) {
              // Update the args on the existing tool_call part
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(chunk.arguments ?? '{}') as Record<string, unknown>;
              } catch {
                // Keep empty args
              }
              accumulatedParts = accumulatedParts.map((p) =>
                p.type === 'tool_call' && p.toolCallId === chunk.callId
                  ? { ...p, args: parsedArgs }
                  : p
              );
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'tool_result' && chunk.callId) {
              const resultPart: MessagePart = {
                type: 'tool_result',
                toolCallId: chunk.callId,
                content: JSON.stringify(chunk.result),
                isError: chunk.isError,
              };
              accumulatedParts = [...accumulatedParts, resultPart];
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'context_info') {
              if (
                chunk.estimatedInputTokens != null &&
                chunk.contextLimit != null &&
                chunk.estimatedUsageRatio != null &&
                chunk.mode != null &&
                chunk.severity != null
              ) {
                setContextInfo({
                  estimatedInputTokens: chunk.estimatedInputTokens,
                  contextLimit: chunk.contextLimit,
                  estimatedUsageRatio: chunk.estimatedUsageRatio,
                  mode: chunk.mode,
                  severity: chunk.severity,
                });
              }
            } else if (chunkType === 'fallback_notice') {
              if (chunk.from != null && chunk.to != null && chunk.reason != null) {
                setFallbackNotice({
                  from: chunk.from,
                  to: chunk.to,
                  reason: chunk.reason,
                });
              }
            } else if (chunk.done) {
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                isGenerating: false,
                text: accumulatedText,
                parts: [...accumulatedParts],
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
      thinkingEnabled,
      reasoningEffort,
    ]
  );

  return { isGenerating, handleRespond, handleStop, contextInfo, fallbackNotice };
}
