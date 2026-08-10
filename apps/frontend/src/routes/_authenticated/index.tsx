import type { ModelOption } from '@mangostudio/shared';
import {
  normalizeApprovalRouting,
  normalizePermissionLevel,
} from '@mangostudio/shared/external-agents';
import { createFileRoute } from '@tanstack/react-router';
import { ChatPage } from '@/features/chat/ChatPage';
import { useExternalAgents } from '@/features/external-agents/useExternalAgents';
import { useApp } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated/')({
  component: ChatRoute,
});

function ChatRoute() {
  const app = useApp();
  const selectedModel: ModelOption | undefined = app.activeModels.find(
    (m) => m.modelId === app.activeModel
  );
  const reasoningVisible = selectedModel?.capabilities?.reasoning === true;
  const external = useExternalAgents(app.currentEnvironmentId);
  const descriptor =
    app.runner.kind === 'external' ? external.find(app.runner.targetId) : undefined;

  return (
    <ChatPage
      chatId={app.currentChatId}
      onSubmit={(prompt, attachmentIds) => void app.handleSubmit(prompt, attachmentIds)}
      disabled={app.isGenerating}
      isGenerating={app.isGenerating}
      onStop={app.handleStop}
      thinkingEnabled={app.settings.thinkingEnabled}
      reasoningEffort={app.settings.reasoningEffort}
      onThinkingToggle={app.settings.setThinkingEnabled}
      onReasoningEffortChange={app.settings.setReasoningEffort}
      reasoningVisible={reasoningVisible}
      contextInfo={app.contextInfo}
      fallbackNotice={app.fallbackNotice}
      seedContextInfo={app.seedContextInfo}
      contextSettings={app.settings.contextSettings}
      isContextActionPending={app.isContextActionPending}
      onCompactCurrentChat={app.handleCompactCurrentChat}
      onStartSummarizedChat={app.handleStartSummarizedChat}
      imageToolIntent={app.imageToolIntent}
      onImageToolIntentChange={app.setImageToolIntent}
      activeModel={app.activeModel}
      selectedAgentId={app.selectedAgentId ?? undefined}
      agents={app.agents}
      isAgentListLoading={app.isAgentListLoading}
      onSelectedAgentIdChange={app.setSelectedAgentId}
      environmentId={app.currentEnvironmentId}
      onEnvironmentChange={
        app.currentChatId
          ? (environmentId) => app.updateChatEnvironment(app.currentChatId as string, environmentId)
          : undefined
      }
      workdir={app.currentWorkdir}
      composer={{
        runner: app.runner,
        activeModels: app.activeModels,
        modelCatalog: app.catalog,
        lockedProvider: app.lockedProvider,
        isModelSelectorDisabled: app.isModelSelectorDisabled,
        onModelChange: (model) => {
          if (app.currentChatId) void app.handleUpdateChatModel(app.currentChatId, model);
        },
        externalDescriptor: descriptor,
        externalModel: app.externalTurnRequest.model ?? null,
        externalEffort: app.externalTurnRequest.effort ?? null,
        // Unchosen resolves restrictively here exactly as it does server-side, so
        // the control shows what the turn would actually run as.
        externalLevel: normalizePermissionLevel(app.runnerPermissions.level).value,
        externalRouting: normalizeApprovalRouting(app.runnerPermissions.routing).value,
        onExternalModelChange: (model) =>
          app.setExternalTurnRequest((current) => ({
            ...current,
            ...(model ? { model } : { model: undefined }),
          })),
        onExternalEffortChange: (effort) =>
          app.setExternalTurnRequest((current) => ({
            ...current,
            ...(effort ? { effort } : { effort: undefined }),
          })),
        onExternalPermissionsChange: app.setRunnerPermissions,
      }}
      workspaceSettings={app.settings.workspaceSettings}
      onWorkspacePanelWidthChange={app.settings.setWorkspacePanelWidth}
      isWorkdirPickerOpen={app.isWorkdirPickerOpen}
      onOpenWorkdirPicker={app.openWorkdirPicker}
      onCloseWorkdirPicker={app.closeWorkdirPicker}
      onSelectWorkdir={app.selectWorkdir}
      restrictToolsToWorkdirOverride={app.restrictToolsToWorkdirOverride}
      onRestrictToolsToWorkdirOverrideChange={
        app.currentChatId
          ? (value) => app.updateChatRestrictToolsToWorkdir(app.currentChatId as string, value)
          : undefined
      }
      onResumeInterruptedTurn={app.handleResumeInterruptedTurn}
      onDismissInterruptedTurn={app.handleDismissInterruptedTurn}
    />
  );
}
