/* global console */

import type { Message, MessagePart, ReasoningEffort } from '@mangostudio/shared';
import { type AgentExecutionMode, isAgentId } from '@mangostudio/shared/agents';
import type { ChatTitleSettings } from '@mangostudio/shared/app-settings';
import {
  type ContextCompactionResponse,
  type ContextSettings,
  createPromptChatTitle,
  isTimestampChatTitle,
} from '@mangostudio/shared/chat';
import type { RespondStreamBody, ToolIntent } from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { invalidateChatFileCheckpoints } from '@/features/chat/hooks/use-chat-file-checkpoints';
import { useChatStream } from '@/features/chat/hooks/use-chat-stream';
import { setChatTodos } from '@/features/chat/hooks/use-chat-todos';
import type { useChats } from '@/features/chat/hooks/use-chats';
import { messageKeys } from '@/features/chat/queries';
import { generateChatTitleSuggestion } from '@/features/chat/services/chat-title';
import { compactChat, summarizeToNewChat } from '@/features/chat/services/context-compaction';
import type { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import {
  createTextGenerationStreamState,
  reduceTextGenerationStreamChunk,
  type TextGenerationStreamMessageUpdate,
} from '@/features/generation/text-generation-stream-reducer';
import { invalidateGitState } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  cancelInterruptedTurn,
  dismissInterruptedTurn,
  respondTextStream,
} from '@/services/generation-service';

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
  chatTitleSettings: ChatTitleSettings;
  currentChatId: string | null;
  getAgentSelection: () => {
    readonly mode: AgentExecutionMode;
    readonly agentId: string;
    readonly agentName?: string;
  };
}

type RecoveryRequest = NonNullable<RespondStreamBody['recovery']>;

function resolveSummaryModelId(settings: ContextSettings, currentModel: string): string {
  return settings.preferredSummaryModel === 'current_model'
    ? currentModel
    : settings.preferredSummaryModel;
}

function shouldRenameChatFromPrompt(
  chatTitleSettings: ChatTitleSettings,
  currentTitle: string | undefined,
  createdChatDuringRequest: boolean
): boolean {
  if (!chatTitleSettings.autoRenameEnabled) return false;
  if (createdChatDuringRequest) return true;
  return currentTitle !== undefined && isTimestampChatTitle(currentTitle);
}

function resolveChatTitleModel(settings: ChatTitleSettings, currentModel: string): string {
  return settings.preferredModel === 'current_model' ? currentModel : settings.preferredModel;
}

async function createAutoChatTitle(
  prompt: string,
  chatTitleSettings: ChatTitleSettings,
  currentModel: string
): Promise<string | null> {
  const fallbackTitle = createPromptChatTitle(prompt, chatTitleSettings.promptPrefixLength);
  if (!fallbackTitle || chatTitleSettings.strategy === 'prompt_prefix') return fallbackTitle;

  try {
    const response = await generateChatTitleSuggestion({
      prompt,
      model: resolveChatTitleModel(chatTitleSettings, currentModel),
    });
    return response.title;
  } catch {
    return fallbackTitle;
  }
}

async function renameChatFromPrompt({
  chats,
  chatId,
  prompt,
  chatTitleSettings,
  currentModel,
}: {
  chats: ReturnType<typeof useChats>;
  chatId: string;
  prompt: string;
  chatTitleSettings: ChatTitleSettings;
  currentModel: string;
}): Promise<void> {
  const promptTitle = await createAutoChatTitle(prompt, chatTitleSettings, currentModel);
  if (promptTitle) {
    await chats.updateChatTitle(chatId, promptTitle);
  }
}

function startChatAutoRename(input: Parameters<typeof renameChatFromPrompt>[0]): void {
  void renameChatFromPrompt(input).catch((error: unknown) => {
    console.warn('[chat-title] Failed to auto rename chat', error);
  });
}

function applyStreamMessageUpdate(
  chatId: string,
  update: TextGenerationStreamMessageUpdate | null,
  updateOptimisticMessage: UseTextGenerationOptions['optimistic']['updateOptimisticMessage']
) {
  if (!update) return;
  updateOptimisticMessage(chatId, update.targetMessageId, update.patch);
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
  chatTitleSettings,
  currentChatId,
  getAgentSelection,
}: UseTextGenerationOptions) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const pendingSubagentName = t.chat.feed.subagentPendingName;
  const stream = useChatStream({ currentChatId });
  const { appendOptimisticMessages, updateOptimisticMessage } = optimistic;
  const activeTurnRef = useRef<{ readonly chatId: string; readonly messageId: string } | null>(
    null
  );
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
    async (
      prompt: string,
      toolIntent?: ToolIntent,
      attachmentIds?: string[],
      recovery?: RecoveryRequest
    ) => {
      if (stream.abortControllerRef.current) return;
      stream.setIsGenerating(true);

      let activeChatId = chats.currentChatId;
      let createdChatDuringRequest = false;
      let activeChatTitle = chats.currentChat?.title;
      if (!activeChatId) {
        const newChat = await chats.createChat();
        activeChatId = newChat.id;
        activeChatTitle = newChat.title;
        createdChatDuringRequest = true;
      }

      const model = getActiveModel();
      const agentSelection = getAgentSelection();
      const interactionMode = agentSelection.mode === 'agent' ? 'agent' : 'chat';

      if (
        !recovery &&
        shouldRenameChatFromPrompt(chatTitleSettings, activeChatTitle, createdChatDuringRequest)
      ) {
        startChatAutoRename({
          chats,
          chatId: activeChatId,
          prompt,
          chatTitleSettings,
          currentModel: model,
        });
      }

      const optimisticUserMsgId = `optimistic-user-${crypto.randomUUID()}`;
      const optimisticAiMsgId = `optimistic-ai-${crypto.randomUUID()}`;

      const optimisticUserMsg: Message = {
        id: optimisticUserMsgId,
        chatId: activeChatId,
        role: 'user',
        text: prompt,
        timestamp: Date.now(),
        interactionMode,
        ...(interactionMode === 'agent'
          ? { agentId: agentSelection.agentId, agentName: agentSelection.agentName }
          : {}),
      };

      const optimisticAiMsg: Message = {
        id: optimisticAiMsgId,
        chatId: activeChatId,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: true,
        modelName: model,
        interactionMode,
        ...(interactionMode === 'agent'
          ? { agentId: agentSelection.agentId, agentName: agentSelection.agentName }
          : {}),
      };

      appendOptimisticMessages(activeChatId, [optimisticUserMsg, optimisticAiMsg]);

      const controller = new AbortController();
      stream.setAbortController(controller);
      let streamState = createTextGenerationStreamState({
        userMessageId: optimisticUserMsgId,
        aiMessageId: optimisticAiMsgId,
      });

      try {
        await respondTextStream(
          {
            chatId: activeChatId,
            prompt,
            attachmentIds,
            model,
            systemPrompt: systemPrompt || undefined,
            promptSettings,
            thinkingEnabled,
            reasoningEffort,
            maxToolIterations,
            contextSettings,
            toolIntent,
            agentMode: agentSelection.mode,
            agentId: isAgentId(agentSelection.agentId) ? agentSelection.agentId : undefined,
            recovery,
          },
          (chunk) => {
            streamState = reduceTextGenerationStreamChunk(streamState, chunk, {
              pendingSubagentName,
            });
            applyStreamMessageUpdate(
              activeChatId,
              streamState.userMessageUpdate,
              updateOptimisticMessage
            );
            applyStreamMessageUpdate(
              activeChatId,
              streamState.aiMessageUpdate,
              updateOptimisticMessage
            );

            if (chunk.type === 'assistant_message_id') {
              activeTurnRef.current = { chatId: activeChatId, messageId: chunk.messageId };
              if (recovery) {
                void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId) });
              }
            }

            if (chunk.type === 'context_info') {
              stream.updateContextInfo(activeChatId, {
                estimatedInputTokens: chunk.estimatedInputTokens,
                contextLimit: chunk.contextLimit,
                estimatedUsageRatio: chunk.estimatedUsageRatio,
                mode: chunk.mode,
                severity: chunk.severity,
              });
            }

            if (chunk.type === 'fallback_notice') {
              stream.setFallbackNotice({ from: chunk.from, to: chunk.to, reason: chunk.reason });
            }

            if (chunk.type === 'todo_update') {
              setChatTodos(queryClient, activeChatId, chunk.todos);
            }
          },
          controller.signal
        );
      } catch (error: unknown) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          updateOptimisticMessage(activeChatId, streamState.currentAiMessageId, {
            isGenerating: false,
          });
        } else {
          console.error('[respond]', error);
          const errorText = resolveApiErrorMessage(error, t.errors.textGenerationFailed);
          const alreadyHasError = streamState.parts.some((part) => part.type === 'error');
          const nextParts: MessagePart[] = alreadyHasError
            ? streamState.parts
            : [...streamState.parts, { type: 'error', text: errorText }];
          updateOptimisticMessage(activeChatId, streamState.currentAiMessageId, {
            isGenerating: false,
            text: streamState.text || errorText,
            parts: nextParts,
          });
        }
        if (recovery) throw error;
      } finally {
        activeTurnRef.current = null;
        stream.setAbortController(null);
        stream.setIsGenerating(false);
        void invalidateGitState(queryClient, activeChatId);
        invalidateChatFileCheckpoints(queryClient, activeChatId);
        if (createdChatDuringRequest) {
          void chats.loadChats();
        }
        if (
          recovery ||
          !streamState.receivedServerUserMessageId ||
          !streamState.receivedServerAiMessageId
        ) {
          void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId) });
        }
      }
    },
    [
      chats,
      getActiveModel,
      systemPrompt,
      promptSettings,
      t,
      appendOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
      thinkingEnabled,
      reasoningEffort,
      maxToolIterations,
      contextSettings,
      chatTitleSettings,
      getAgentSelection,
      stream,
      pendingSubagentName,
    ]
  );

  const handleStop = useCallback(() => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn) {
      stream.handleStop();
      return;
    }

    void cancelInterruptedTurn(activeTurn.chatId, activeTurn.messageId)
      .catch((error: unknown) => {
        console.warn('[turn-recovery] Failed to persist turn cancellation', error);
      })
      .finally(() => {
        stream.handleStop();
      });
  }, [stream]);

  const handleResumeInterruptedTurn = useCallback(
    async (messageId: string, retryCallIds: string[]) => {
      await handleRespond(t.chat.recovery.resumeUserMessage, undefined, undefined, {
        messageId,
        requestId: crypto.randomUUID(),
        retryCallIds,
      });
    },
    [handleRespond, t.chat.recovery.resumeUserMessage]
  );

  const handleDismissInterruptedTurn = useCallback(
    async (messageId: string) => {
      const chatId = chats.currentChatId;
      if (!chatId) return;
      await dismissInterruptedTurn(chatId, messageId);
      await queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) });
    },
    [chats.currentChatId, queryClient]
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
    handleStop,
    handleResumeInterruptedTurn,
    handleDismissInterruptedTurn,
    contextInfo: stream.contextInfo,
    fallbackNotice: stream.fallbackNotice,
    seedContextInfo: stream.seedContextInfo,
    contextCache: stream.contextCache,
    isContextActionPending: pendingContextAction !== null,
  };
}
