import { useNavigate } from '@tanstack/react-router';
import { useChats } from '@/features/chat/hooks/use-chats';
import { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import { useTextGeneration } from '@/features/generation/hooks/use-text-generation';
import { useActiveChatModel } from './use-active-chat-model';
import { useAgentSelection } from './use-agent-selection';
import { useChatContextSync } from './use-chat-context-sync';
import { useChatRouteActions } from './use-chat-route-actions';
import { useGenerationControls } from './use-generation-controls';
import { useGlobalSettings } from './use-global-settings';
import { useModelCatalog } from './use-model-catalog';

export function useAppState() {
  const chats = useChats();
  const catalog = useModelCatalog();
  const settings = useGlobalSettings();
  const navigate = useNavigate();
  const optimistic = useOptimisticMessages();
  const currentChat = chats.currentChat;
  const modelState = useActiveChatModel({
    catalog: catalog.catalog,
    settings,
    currentTextModel: currentChat?.textModel,
  });
  const agentSelection = useAgentSelection({
    currentChatId: chats.currentChatId,
    currentChat,
    updateChatAgentSelection: chats.updateChatAgentSelection,
  });

  const textGen = useTextGeneration({
    chats,
    getActiveModel: modelState.getActiveModel,
    systemPrompt: settings.globalTextSystemPrompt,
    promptSettings: settings.promptSettings,
    optimistic,
    thinkingEnabled: modelState.effectiveThinkingEnabled,
    reasoningEffort: modelState.effectiveReasoningEffort,
    maxToolIterations: modelState.effectiveMaxToolIterations,
    contextSettings: settings.contextSettings,
    chatTitleSettings: settings.chatTitleSettings,
    currentChatId: chats.currentChatId,
    getAgentSelection: () => ({
      mode: agentSelection.agentExecutionMode,
      agentId:
        agentSelection.agentExecutionMode === 'agent' ? agentSelection.selectedAgentId : 'chat',
      agentName:
        agentSelection.agentExecutionMode === 'agent'
          ? agentSelection.selectedAgent?.name
          : undefined,
    }),
  });
  useChatContextSync(chats.chats, textGen.seedContextInfo);

  const chatActions = useChatRouteActions({ chats, navigate });
  const generationControls = useGenerationControls({
    handleRespond: textGen.handleRespond,
    stopGeneration: textGen.handleStop,
  });

  return {
    imageToolIntent: generationControls.imageToolIntent,
    agentExecutionMode: agentSelection.agentExecutionMode,
    selectedAgentId: agentSelection.selectedAgentId,
    agents: agentSelection.agents,
    isAgentListLoading: agentSelection.isAgentListLoading,
    isGenerating: textGen.isGenerating,
    chats: chats.chats,
    currentChatId: chats.currentChatId,
    catalog: catalog.catalog,
    settings,
    activeModels: modelState.activeModels,
    activeModel: modelState.activeModel,
    isModelSelectorDisabled: modelState.isModelSelectorDisabled,
    contextInfo: textGen.contextInfo,
    fallbackNotice: textGen.fallbackNotice,
    seedContextInfo: textGen.seedContextInfo,
    contextCache: textGen.contextCache,
    isContextActionPending: textGen.isContextActionPending,
    lockedProvider: modelState.lockedProvider,

    setImageToolIntent: generationControls.setImageToolIntent,
    setAgentExecutionMode: agentSelection.setAgentExecutionMode,
    setSelectedAgentId: agentSelection.setSelectedAgentId,
    handleNewChat: chatActions.handleNewChat,
    handleUpdateChatModel: chatActions.handleUpdateChatModel,
    handleUpdateChatTitle: chatActions.handleUpdateChatTitle,
    handleDeleteChat: chatActions.handleDeleteChat,
    handleSelectChat: chatActions.handleSelectChat,
    handleNavigate: chatActions.handleNavigate,
    handleSubmit: generationControls.handleSubmit,
    handleStop: generationControls.handleStop,
    handleCompactCurrentChat: textGen.handleCompactCurrentChat,
    handleStartSummarizedChat: textGen.handleStartSummarizedChat,
    refreshCatalog: catalog.refreshCatalog,
  };
}
