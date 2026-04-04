import { useEffect } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { ChatFeed } from '../../components/ChatFeed';
import { InputBar } from '../../components/InputBar';
import { useMessagesQuery } from '../../hooks/use-messages-query';
import { useI18n } from '../../hooks/use-i18n';
import type { InteractionMode, ReasoningEffort } from '@mangostudio/shared';
import type { ContextInfo, FallbackNotice } from '../../hooks/use-text-chat';

interface ChatPageProps {
  chatId: string | null;
  composerMode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  onSubmit: (prompt: string, referenceImage?: File | null) => void;
  disabled: boolean;
  isGenerating: boolean;
  onStop: () => void;
  // Reasoning controls
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  onThinkingToggle: (enabled: boolean) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  reasoningVisible: boolean;
  // Context awareness
  contextInfo?: ContextInfo | null;
  fallbackNotice?: FallbackNotice | null;
  seedContextInfo?: (chatId: string, info: ContextInfo) => void;
}

export function ChatPage({
  chatId,
  composerMode,
  onModeChange,
  onSubmit,
  disabled,
  isGenerating,
  onStop,
  thinkingEnabled,
  reasoningEffort,
  onThinkingToggle,
  onReasoningEffortChange,
  reasoningVisible,
  contextInfo,
  fallbackNotice,
  seedContextInfo,
}: ChatPageProps) {
  const { data, status } = useMessagesQuery(chatId);
  const { t } = useI18n();

  // Seed context info from persisted providerState on chat load
  const firstPageContextInfo = data?.pages[0]?.contextInfo;
  useEffect(() => {
    if (chatId && firstPageContextInfo && seedContextInfo) {
      seedContextInfo(chatId, firstPageContextInfo);
    }
  }, [chatId, firstPageContextInfo, seedContextInfo]);

  const messages = data?.pages.flatMap((page) => page.messages) || [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {status === 'pending' && chatId ? (
        <div className="flex-1 flex justify-center items-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-on-surface/25 select-none">
          <MessageSquare size={48} strokeWidth={1} />
          <p className="text-sm font-body">{t.chat.empty}</p>
        </div>
      ) : (
        <ChatFeed chatId={chatId} messages={messages} />
      )}
      {fallbackNotice && (
        <div className="px-6 py-2 text-xs text-on-surface-variant bg-surface-container-low border-t border-outline-variant/10">
          {fallbackNotice.to === 'replay'
            ? t.chat.fallback.toReplay
            : t.chat.fallback.generic
                .replace('{from}', fallbackNotice.from)
                .replace('{to}', fallbackNotice.to)}
        </div>
      )}
      <InputBar
        composerMode={composerMode}
        onModeChange={onModeChange}
        onSubmit={onSubmit}
        disabled={disabled}
        isGenerating={isGenerating}
        onStop={onStop}
        thinkingEnabled={thinkingEnabled}
        reasoningEffort={reasoningEffort}
        onThinkingToggle={onThinkingToggle}
        onReasoningEffortChange={onReasoningEffortChange}
        reasoningVisible={reasoningVisible}
        contextInfo={contextInfo}
      />
    </div>
  );
}
