import { Loader2, MessageSquare } from 'lucide-react';
import { ChatFeed } from '../../components/ChatFeed';
import { InputBar } from '../../components/InputBar';
import { useMessagesQuery } from '../../hooks/use-messages-query';
import { useI18n } from '../../hooks/use-i18n';
import type { InteractionMode } from '@mangostudio/shared';

interface ChatPageProps {
  chatId: string | null;
  composerMode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  onSubmit: (prompt: string, referenceImage?: File | null) => void;
  disabled: boolean;
  isGenerating: boolean;
  onStop: () => void;
}

export function ChatPage({
  chatId,
  composerMode,
  onModeChange,
  onSubmit,
  disabled,
  isGenerating,
  onStop,
}: ChatPageProps) {
  const { data, status } = useMessagesQuery(chatId);
  const { t } = useI18n();

  const messages = data?.pages.flatMap((page) => page.messages) || [];

  return (
    <>
      {status === 'pending' && chatId ? (
        <div className="flex-1 flex justify-center items-center h-full">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-on-surface/25 select-none">
          <MessageSquare size={48} strokeWidth={1} />
          <p className="text-sm font-body">{t.chat.empty}</p>
        </div>
      ) : (
        <ChatFeed messages={messages} />
      )}
      <InputBar
        composerMode={composerMode}
        onModeChange={onModeChange}
        onSubmit={onSubmit}
        disabled={disabled}
        isGenerating={isGenerating}
        onStop={onStop}
      />
    </>
  );
}
