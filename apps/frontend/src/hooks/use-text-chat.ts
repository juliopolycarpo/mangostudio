/* global console */
import { useState, useCallback, useRef, useEffect } from 'react';
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
  currentChatId: string | null;
}

/** Handles text chat streaming — send prompt, manage SSE stream, optimistic UI. */
export function useTextChat({
  chats,
  getActiveModel,
  systemPrompt,
  optimistic,
  thinkingEnabled,
  reasoningEffort,
  currentChatId,
}: UseTextChatOptions) {
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<FallbackNotice | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Per-chat context info cache — survives chat switches
  const contextCacheRef = useRef<Map<string, ContextInfo>>(new Map());
  // Version counter makes contextCache reactive: incrementing it triggers re-renders
  // in consumers (e.g. Sidebar) that read from the mutable Map.
  const [, setCacheVersion] = useState(0);
  // Ref to current chatId to avoid stale closures in seedContextInfo.
  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;

  // Restore cached context when the active chat changes (or clear if none)
  useEffect(() => {
    if (currentChatId) {
      const cached = contextCacheRef.current.get(currentChatId);
      setContextInfo(cached ?? null);
    } else {
      setContextInfo(null);
    }
    setFallbackNotice(null);
  }, [currentChatId]);

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
      let thinkingSegments: string[] = [];
      let currentThinkingIdx = -1;
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

            if (chunkType === 'thinking_start') {
              // Start a new thinking segment — push placeholder into parts
              thinkingSegments.push('');
              currentThinkingIdx = thinkingSegments.length - 1;
              const thinkingPart: MessagePart = { type: 'thinking', text: '' };
              accumulatedParts = [...accumulatedParts, thinkingPart];
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'thinking' && chunk.text) {
              if (currentThinkingIdx < 0) {
                // Fallback: no thinking_start received (legacy API) — create segment implicitly
                thinkingSegments.push('');
                currentThinkingIdx = thinkingSegments.length - 1;
                accumulatedParts = [...accumulatedParts, { type: 'thinking', text: '' }];
              }
              thinkingSegments[currentThinkingIdx] += chunk.text;
              // Update the last thinking part in accumulatedParts (current segment)
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
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'text' && !chunk.done && chunk.text) {
              currentThinkingIdx = -1;
              accumulatedText += chunk.text;
              const textPart: MessagePart = { type: 'text', text: accumulatedText };
              accumulatedParts = [...accumulatedParts.filter((p) => p.type !== 'text'), textPart];
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                text: accumulatedText,
                parts: [...accumulatedParts],
              });
            } else if (chunkType === 'tool_call_started' && chunk.callId) {
              currentThinkingIdx = -1;
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
                const info: ContextInfo = {
                  estimatedInputTokens: chunk.estimatedInputTokens,
                  contextLimit: chunk.contextLimit,
                  estimatedUsageRatio: chunk.estimatedUsageRatio,
                  mode: chunk.mode,
                  severity: chunk.severity,
                };
                setContextInfo(info);
                if (activeChatId) {
                  contextCacheRef.current.set(activeChatId, info);
                  setCacheVersion((v) => v + 1);
                }
              }
            } else if (chunkType === 'fallback_notice') {
              if (chunk.from != null && chunk.to != null && chunk.reason != null) {
                setFallbackNotice({
                  from: chunk.from,
                  to: chunk.to,
                  reason: chunk.reason,
                });
              }
            } else if (chunkType === 'system_event' && chunk.event) {
              accumulatedParts.push({
                type: 'system_event',
                event: chunk.event,
                detail: chunk.detail,
              });
              updateOptimisticMessage(activeChatId!, optimisticAiMsgId, {
                parts: [...accumulatedParts],
              });
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

  const seedContextInfo = useCallback(
    (chatId: string, info: ContextInfo) => {
      contextCacheRef.current.set(chatId, info);
      setCacheVersion((v) => v + 1);
      // Use ref instead of closure to always read the current chatId,
      // avoiding the stale-closure race on cold start.
      if (chatId === currentChatIdRef.current) {
        setContextInfo(info);
      }
    },
    [] // stable — reads currentChatId via ref
  );

  return {
    isGenerating,
    handleRespond,
    handleStop,
    contextInfo,
    fallbackNotice,
    seedContextInfo,
    /** Per-chat context cache — readable by sidebar for progress indicators. */
    contextCache: contextCacheRef.current,
  };
}
