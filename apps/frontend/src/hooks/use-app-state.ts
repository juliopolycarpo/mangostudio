import { useNavigate } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';
import { useChats } from '@/features/chat/hooks/use-chats';
import { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import { useTextGeneration } from '@/features/generation/hooks/use-text-generation';
import { useActiveChatModel } from './use-active-chat-model';
import { useChatContextSync } from './use-chat-context-sync';
import { useChatRouteActions } from './use-chat-route-actions';
import { useExternalTurnRequest } from './use-external-turn-request';
import { useGenerationControls } from './use-generation-controls';
import { useGlobalSettings } from './use-global-settings';
import { useModelCatalog } from './use-model-catalog';
import { useRunnerSelection } from './use-runner-selection';

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
  const runnerSelection = useRunnerSelection({
    currentChatId: chats.currentChatId,
    currentChat,
    updateChatRunner: chats.updateChatRunner,
    updateChatRunnerPermissions: chats.updateChatRunnerPermissions,
    defaultWorkdir: settings.workspaceSettings.defaultWorkdir,
    updateChatWorkdir: chats.updateChatWorkdir,
    addRecentWorkdir: settings.addRecentWorkdir,
  });

  const { externalTurnRequest, setExternalTurnRequest, getExternalTurnRequest } =
    useExternalTurnRequest(chats.currentChatId);

  // Read through a ref for the same reason the vendor options are: the send
  // path has to see the runner the composer shows now, not the one it showed
  // when the callback was created.
  //
  // This is the *selected* runner, which is what the turn header should name
  // while the turn streams. It can be ahead of the stored one — the selector
  // writes optimistically — but only a write that is then rejected leaves the
  // two permanently disagreeing; `whenRunnerPersisted` settles the rest before
  // the stream opens, so the hub dispatches on the runner shown here.
  const runnerRef = useRef(runnerSelection.runner);
  runnerRef.current = runnerSelection.runner;
  const getExternalRunnerTargetId = useCallback(() => {
    const runner = runnerRef.current;
    return runner.kind === 'external' ? runner.targetId : undefined;
  }, []);

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
      agentId: runnerSelection.selectedAgentId ?? 'default',
      agentName: runnerSelection.selectedAgent?.name,
    }),
    getExternalTurnRequest,
    getExternalRunnerTargetId,
    whenRunnerPersisted: runnerSelection.whenRunnerPersisted,
    onChatCreated: runnerSelection.bindNewChat,
  });
  useChatContextSync(chats.chats, textGen.seedContextInfo);

  const chatActions = useChatRouteActions({ chats, navigate });
  const generationControls = useGenerationControls({
    handleRespond: textGen.handleRespond,
    stopGeneration: textGen.handleStop,
  });

  return {
    imageToolIntent: generationControls.imageToolIntent,
    runner: runnerSelection.runner,
    runnerPermissions: runnerSelection.runnerPermissions,
    externalTurnRequest,
    setExternalTurnRequest,
    selectedAgentId: runnerSelection.selectedAgentId,
    agents: runnerSelection.agents,
    isAgentListLoading: runnerSelection.isAgentListLoading,
    currentWorkdir: runnerSelection.currentWorkdir,
    isWorkdirPickerOpen: runnerSelection.isWorkdirPickerOpen,
    isGenerating: textGen.isGenerating,
    chats: chats.chats,
    currentChatId: chats.currentChatId,
    currentEnvironmentId: currentChat?.environmentId ?? null,
    catalog: catalog.catalog,
    settings,
    activeModels: modelState.activeModels,
    activeModel: modelState.activeModel,
    isModelSelectorDisabled: modelState.isModelSelectorDisabled,
    contextInfo: textGen.contextInfo,
    threadUsage: textGen.threadUsage,
    fallbackNotice: textGen.fallbackNotice,
    seedContextInfo: textGen.seedContextInfo,
    contextCache: textGen.contextCache,
    isContextActionPending: textGen.isContextActionPending,
    modelUnavailable: textGen.modelUnavailable,
    dismissModelUnavailable: textGen.dismissModelUnavailable,
    lockedProvider: modelState.lockedProvider,

    setImageToolIntent: generationControls.setImageToolIntent,
    setSelectedAgentId: runnerSelection.setRunnerAgentId,
    setRunnerTarget: runnerSelection.setRunnerTarget,
    setRunnerPermissions: runnerSelection.setRunnerPermissions,
    openWorkdirPicker: runnerSelection.openWorkdirPicker,
    closeWorkdirPicker: runnerSelection.closeWorkdirPicker,
    selectWorkdir: runnerSelection.selectWorkdir,
    updateChatEnvironment: chats.updateChatEnvironment,
    restrictToolsToWorkdirOverride: currentChat?.restrictToolsToWorkdir ?? null,
    updateChatRestrictToolsToWorkdir: chats.updateChatRestrictToolsToWorkdir,
    handleNewChat: chatActions.handleNewChat,
    handleUpdateChatModel: chatActions.handleUpdateChatModel,
    handleUpdateChatTitle: chatActions.handleUpdateChatTitle,
    handleDeleteChat: chatActions.handleDeleteChat,
    handleSelectChat: chatActions.handleSelectChat,
    handleNavigate: chatActions.handleNavigate,
    handleSubmit: generationControls.handleSubmit,
    handleStop: generationControls.handleStop,
    handleReviewChanges: textGen.handleReviewChanges,
    handleCompactCurrentChat: textGen.handleCompactCurrentChat,
    handleStartSummarizedChat: textGen.handleStartSummarizedChat,
    handleResumeInterruptedTurn: textGen.handleResumeInterruptedTurn,
    handleDismissInterruptedTurn: textGen.handleDismissInterruptedTurn,
    refreshCatalog: catalog.refreshCatalog,
  };
}
