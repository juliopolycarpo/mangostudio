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
import type { ToolIntent } from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useChatStream } from '@/features/chat/hooks/use-chat-stream';
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
import { useI18n } from '@/hooks/use-i18n';
import { respondTextStream } from '@/services/generation-service';

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
    async (prompt: string, toolIntent?: ToolIntent) => {
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
          const errorText = error instanceof Error ? error.message : t.errors.textGenerationFailed;
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
      } finally {
        stream.setAbortController(null);
        stream.setIsGenerating(false);
        if (createdChatDuringRequest) {
          void chats.loadChats();
        }
        if (!streamState.receivedServerUserMessageId || !streamState.receivedServerAiMessageId) {
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
