import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '@/lib/app-context';
import { ChatPage } from '@/features/chat/ChatPage';
import type { ModelOption } from '@mangostudio/shared';

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
      onSubmit={(prompt) => void app.handleSubmit(prompt)}
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
    />
  );
}
