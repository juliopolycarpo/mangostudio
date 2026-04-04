import { useEffect } from 'react';
import { Loader2, Sparkles, MessageSquare, Code, Bug, Image } from 'lucide-react';
import { ChatFeed } from '../../components/ChatFeed';
import { InputBar } from '../../components/InputBar';
import { useMessagesQuery } from '../../hooks/use-messages-query';
import { useI18n } from '../../hooks/use-i18n';
import { authClient } from '../../lib/auth-client';
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
  const { data: session } = authClient.useSession();
  const userName = session?.user?.name?.split(' ')[0] ?? '';

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
        <div className="flex-1 flex flex-col items-center justify-center gap-6 select-none px-6">
          <div className="text-center">
            <Sparkles size={36} className="mx-auto mb-3 text-primary/40" />
            <h2 className="text-lg font-headline font-bold text-on-surface/80">
              {t.chat.emptyGreeting.replace('{name}', userName)}
            </h2>
            <p className="text-sm text-on-surface-variant/50 mt-1">{t.chat.emptySubtitle}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 max-w-lg">
            {[
              { text: t.chat.suggestion1, icon: <MessageSquare size={14} /> },
              { text: t.chat.suggestion2, icon: <Code size={14} /> },
              { text: t.chat.suggestion3, icon: <Bug size={14} /> },
              {
                text: t.chat.suggestion4,
                icon: <Image size={14} />,
                action: () => {
                  onModeChange('image');
                },
              },
            ].map((chip) => (
              <button
                key={chip.text}
                type="button"
                onClick={() => {
                  chip.action?.();
                  if (!chip.action) onSubmit(chip.text);
                }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-body text-on-surface-variant border border-outline-variant/20 hover:border-outline-variant/40 hover:text-on-surface transition-colors duration-200 cursor-pointer"
                style={{ background: 'rgba(28,27,27,0.6)', backdropFilter: 'blur(8px)' }}
              >
                {chip.icon}
                {chip.text}
              </button>
            ))}
          </div>
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
