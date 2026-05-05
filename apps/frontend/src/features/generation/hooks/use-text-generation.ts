/* global console */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  GeneratedImagePart,
  Message,
  MessagePart,
  ReasoningEffort,
} from '@mangostudio/shared';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import type { ContextCompactionResponse, ContextSettings } from '@mangostudio/shared/chat';
import { messageKeys } from '@/features/chat/queries';
import { compactChat, summarizeToNewChat } from '@/features/chat/services/context-compaction';
import { respondTextStream } from '@/services/generation-service';
import { useChatStream } from '@/features/chat/hooks/use-chat-stream';
import type { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import type { useChats } from '@/features/chat/hooks/use-chats';

interface UseTextGenerationOptions {
  chats: ReturnType<typeof useChats>;
  getActiveModel: () => string;
  systemPrompt: string;
  promptSettings?: PromptSettings;
  optimistic: ReturnType<typeof useOptimisticMessages>;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxToolIterations: number;
  contextSettings: ContextSettings;
  currentChatId: string | null;
}

function resolveSummaryModelId(settings: ContextSettings, currentModel: string): string {
  return settings.preferredSummaryModel === 'current_model'
    ? currentModel
    : settings.preferredSummaryModel;
}

function upsertGeneratedImagePart(
  parts: MessagePart[],
  generatedImagePart: GeneratedImagePart
): MessagePart[] {
  const existingIndex = parts.findIndex(
    (part) =>
      part.type === 'generated_image' &&
      part.imageId === generatedImagePart.imageId &&
      part.toolCallId === generatedImagePart.toolCallId
  );

  if (existingIndex === -1) {
    return [...parts, generatedImagePart];
  }

  return parts.map((part, index) => (index === existingIndex ? generatedImagePart : part));
}

/** Handles text generation: creates messages, drives SSE stream, updates optimistic UI. */
export function useTextGeneration({
  chats,
  getActiveModel,
  systemPrompt,
  promptSettings,
  optimistic,
  thinkingEnabled,
  reasoningEffort,
  maxToolIterations,
  contextSettings,
  currentChatId,
}: UseTextGenerationOptions) {
  const queryClient = useQueryClient();
  const stream = useChatStream({ currentChatId });
  const { appendOptimisticMessages, updateOptimisticMessage } = optimistic;
  const [pendingContextAction, setPendingContextAction] = useState<'compact' | 'new-chat' | null>(
    null
  );

  const syncContextInfo = useCallback(
    (response: ContextCompactionResponse) => {
      if (response.contextInfo) {
        stream.seedContextInfo(response.chatId, response.contextInfo);
      }
    },
    [stream]
  );

  const refreshChatState = useCallback(
    async (chatId: string) => {
      await Promise.all([
        chats.loadChats(),
        queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) }),
      ]);
    },
    [chats, queryClient]
  );

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
      stream.setAbortController(controller);
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
            promptSettings,
            thinkingEnabled,
            reasoningEffort,
            maxToolIterations,
            contextSettings,
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
              case 'image_generation_started': {
                currentThinkingIdx = -1;
                accumulatedParts = upsertGeneratedImagePart(accumulatedParts, {
                  type: 'generated_image',
                  imageId: chunk.imageId,
                  toolCallId: chunk.toolCallId,
                  status: 'generating',
                  prompt: chunk.prompt,
                });
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'image_generation_completed': {
                accumulatedParts = upsertGeneratedImagePart(accumulatedParts, {
                  type: 'generated_image',
                  imageId: chunk.imageId,
                  toolCallId: chunk.toolCallId,
                  status: 'completed',
                  prompt: chunk.prompt,
                  imageUrl: chunk.imageUrl,
                  modelName: chunk.modelName,
                  generationTime: chunk.generationTime,
                });
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
              case 'image_generation_failed': {
                accumulatedParts = upsertGeneratedImagePart(accumulatedParts, {
                  type: 'generated_image',
                  imageId: chunk.imageId,
                  toolCallId: chunk.toolCallId,
                  status: 'error',
                  prompt: chunk.prompt,
                  error: chunk.error,
                  modelName: chunk.modelName,
                  generationTime: chunk.generationTime,
                });
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
              case 'continuation_transition': {
                const transitionPart: MessagePart = {
                  type: 'continuation_transition',
                  provider: chunk.provider,
                  modelName: chunk.modelName,
                  fromProvider: chunk.fromProvider,
                  fromMode: chunk.fromMode,
                  toMode: chunk.toMode,
                  reasonCode: chunk.reasonCode,
                  detail: chunk.detail,
                  recovered: false,
                };
                accumulatedParts = [...accumulatedParts, transitionPart];
                updateOptimisticMessage(activeChatId, optimisticAiMsgId, {
                  parts: accumulatedParts,
                });
                break;
              }
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
        stream.setAbortController(null);
        stream.setIsGenerating(false);
        void chats.loadChats();
        void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId) });
      }
    },
    [
      chats,
      getActiveModel,
      systemPrompt,
      promptSettings,
      appendOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
      thinkingEnabled,
      reasoningEffort,
      maxToolIterations,
      contextSettings,
      stream,
    ]
  );

  const handleCompactCurrentChat = useCallback(async () => {
    const chatId = chats.currentChatId;
    if (!chatId) throw new Error('No active chat available for compaction.');

    setPendingContextAction('compact');
    try {
      const response = await compactChat(chatId, {
        model: resolveSummaryModelId(contextSettings, getActiveModel()),
      });
      syncContextInfo(response);
      await refreshChatState(chatId);
    } finally {
      setPendingContextAction(null);
    }
  }, [chats.currentChatId, contextSettings, getActiveModel, refreshChatState, syncContextInfo]);

  const handleStartSummarizedChat = useCallback(async () => {
    const chatId = chats.currentChatId;
    if (!chatId) throw new Error('No active chat available for summary handoff.');

    setPendingContextAction('new-chat');
    try {
      const response = await summarizeToNewChat(chatId, {
        model: resolveSummaryModelId(contextSettings, getActiveModel()),
      });
      syncContextInfo(response);
      await chats.loadChats();
      chats.setCurrentChatId(response.chatId);
      await queryClient.invalidateQueries({ queryKey: messageKeys.list(response.chatId) });
    } finally {
      setPendingContextAction(null);
    }
  }, [chats, contextSettings, getActiveModel, queryClient, syncContextInfo]);

  return {
    isGenerating: stream.isGenerating,
    handleRespond,
    handleCompactCurrentChat,
    handleStartSummarizedChat,
    handleStop: stream.handleStop,
    contextInfo: stream.contextInfo,
    fallbackNotice: stream.fallbackNotice,
    seedContextInfo: stream.seedContextInfo,
    contextCache: stream.contextCache,
    isContextActionPending: pendingContextAction !== null,
  };
}
