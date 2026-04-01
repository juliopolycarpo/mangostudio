import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '@/lib/app-context';
import { ChatPage } from '@/features/chat/ChatPage';

export const Route = createFileRoute('/_authenticated/')({
  component: ChatRoute,
});

function ChatRoute() {
  const app = useApp();

  return (
    <ChatPage
      chatId={app.currentChatId}
      composerMode={app.composerMode}
      onModeChange={app.setComposerMode}
      onSubmit={app.handleSubmit}
      disabled={app.isGenerating}
      isGenerating={app.isGenerating}
      onStop={app.handleStop}
      streamingThinking={app.streamingThinking}
    />
  );
}
