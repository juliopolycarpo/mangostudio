import type { ModelOption } from '@mangostudio/shared';
import { createFileRoute } from '@tanstack/react-router';
import { ChatPage } from '@/features/chat/ChatPage';
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
      agentExecutionMode={app.agentExecutionMode}
      selectedAgentId={app.selectedAgentId}
      agents={app.agents}
      isAgentListLoading={app.isAgentListLoading}
      onAgentExecutionModeChange={app.setAgentExecutionMode}
      onSelectedAgentIdChange={app.setSelectedAgentId}
      onResumeInterruptedTurn={app.handleResumeInterruptedTurn}
      onDismissInterruptedTurn={app.handleDismissInterruptedTurn}
    />
  );
}
