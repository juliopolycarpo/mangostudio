import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles, MessageSquare, Code, Bug, Image } from 'lucide-react';
import { ChatFeed } from './components/ChatFeed';
import { ContextWarningCallout } from './components/ContextWarningCallout';
import { InputBar } from './components/InputBar';
import { useToast } from '@/components/ui/Toast';
import { useMessagesQuery } from '@/features/chat/queries';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';
import type { InteractionMode, ReasoningEffort } from '@mangostudio/shared';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type { ContextInfo, FallbackNotice } from '@/features/generation/types';

interface ChatPageProps {
  chatId: string | null;
  composerMode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  onSubmit: (prompt: string, referenceImage?: File | null) => void;
  disabled: boolean;
  isGenerating: boolean;
  onStop: () => void;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  onThinkingToggle: (enabled: boolean) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  reasoningVisible: boolean;
  contextInfo?: ContextInfo | null;
  fallbackNotice?: FallbackNotice | null;
  seedContextInfo?: (chatId: string, info: ContextInfo) => void;
  contextSettings: ContextSettings;
  isContextActionPending: boolean;
  onCompactCurrentChat: () => Promise<void>;
  onStartSummarizedChat: () => Promise<void>;
  imageToolIntent: boolean;
  onImageToolIntentChange: (active: boolean) => void;
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
  contextSettings,
  isContextActionPending,
  onCompactCurrentChat,
  onStartSummarizedChat,
  imageToolIntent,
  onImageToolIntentChange,
}: ChatPageProps) {
  const { data, status } = useMessagesQuery(chatId);
  const { t } = useI18n();
  const { toast } = useToast();
  const { data: session } = authClient.useSession();
  const userName = session?.user?.name?.split(' ')[0] ?? '';
  const [continuedWarningKey, setContinuedWarningKey] = useState<string | null>(null);
  const handledAutoWarningKeyRef = useRef<string | null>(null);

  const firstPageContextInfo = data?.pages[0]?.contextInfo;
  useEffect(() => {
    if (chatId && firstPageContextInfo && seedContextInfo) {
      seedContextInfo(chatId, firstPageContextInfo);
    }
  }, [chatId, firstPageContextInfo, seedContextInfo]);

  const messages = data?.pages.flatMap((page) => page.messages) || [];
  const warningKey = useMemo(() => {
    if (!chatId || !contextInfo) return null;
    return `${chatId}:${contextInfo.mode}:${contextInfo.estimatedInputTokens}`;
  }, [chatId, contextInfo]);
  const hasContextWarning =
    composerMode === 'chat' &&
    !!contextInfo &&
    contextInfo.estimatedUsageRatio >= contextSettings.warningThreshold;
  const isDanger =
    !!contextInfo && contextInfo.estimatedUsageRatio >= contextSettings.dangerThreshold;
  const isCritical =
    !!contextInfo && contextInfo.estimatedUsageRatio >= contextSettings.hardStopThreshold;
  const requiresDecision =
    hasContextWarning &&
    contextSettings.compactionBehavior === 'ask' &&
    warningKey !== null &&
    warningKey !== continuedWarningKey;
  const warningMessage = isCritical
    ? t.chat.context.critical
    : isDanger
      ? t.chat.context.danger
      : t.chat.context.warning;

  useEffect(() => {
    if (!hasContextWarning || !warningKey || isContextActionPending) return;
    if (handledAutoWarningKeyRef.current === warningKey) return;

    const runAutoAction = async () => {
      try {
        if (contextSettings.compactionBehavior === 'auto_compact_current_chat') {
          await onCompactCurrentChat();
          toast(t.chat.context.compactedSuccess, 'success');
        }
        if (contextSettings.compactionBehavior === 'continue_with_summary_new_chat') {
          await onStartSummarizedChat();
          toast(t.chat.context.summarizedChatSuccess, 'success');
        }
      } catch {
        const message =
          contextSettings.compactionBehavior === 'continue_with_summary_new_chat'
            ? t.chat.context.summarizedChatFailed
            : t.chat.context.compactFailed;
        toast(message, 'error');
      }
    };

    if (
      contextSettings.compactionBehavior === 'auto_compact_current_chat' ||
      contextSettings.compactionBehavior === 'continue_with_summary_new_chat'
    ) {
      handledAutoWarningKeyRef.current = warningKey;
      void runAutoAction();
    }
  }, [
    contextSettings.compactionBehavior,
    hasContextWarning,
    isContextActionPending,
    onCompactCurrentChat,
    onStartSummarizedChat,
    t.chat.context.compactFailed,
    t.chat.context.compactedSuccess,
    t.chat.context.summarizedChatFailed,
    t.chat.context.summarizedChatSuccess,
    toast,
    warningKey,
  ]);

  const handleCompactClick = async () => {
    try {
      await onCompactCurrentChat();
      toast(t.chat.context.compactedSuccess, 'success');
    } catch {
      toast(t.chat.context.compactFailed, 'error');
    }
  };

  const handleSummarizedChatClick = async () => {
    try {
      await onStartSummarizedChat();
      toast(t.chat.context.summarizedChatSuccess, 'success');
    } catch {
      toast(t.chat.context.summarizedChatFailed, 'error');
    }
  };

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
                className="glass-surface flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-body text-on-surface-variant border border-outline-variant/20 hover:border-outline-variant/40 hover:text-on-surface transition-colors duration-200 cursor-pointer"
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
      {requiresDecision && (
        <div className="px-6 pt-4">
          <div className="mx-auto max-w-4xl">
            <ContextWarningCallout
              title={t.chat.context.label}
              detail={warningMessage}
              keepHistoryNote={t.chat.context.keepHistory}
              compactLabel={t.chat.context.compactAction}
              newChatLabel={t.chat.context.newChatAction}
              continueLabel={t.chat.context.continueAction}
              pendingLabel={t.chat.context.compactPending}
              isPending={isContextActionPending}
              onCompact={() => void handleCompactClick()}
              onStartSummarizedChat={() => void handleSummarizedChatClick()}
              onContinue={() => setContinuedWarningKey(warningKey)}
            />
          </div>
        </div>
      )}
      <InputBar
        composerMode={composerMode}
        onModeChange={onModeChange}
        onSubmit={onSubmit}
        disabled={disabled}
        submitDisabled={requiresDecision || isContextActionPending}
        isGenerating={isGenerating}
        onStop={onStop}
        thinkingEnabled={thinkingEnabled}
        reasoningEffort={reasoningEffort}
        onThinkingToggle={onThinkingToggle}
        onReasoningEffortChange={onReasoningEffortChange}
        reasoningVisible={reasoningVisible}
        contextInfo={contextInfo}
        imageToolIntent={imageToolIntent}
        onImageToolIntentChange={onImageToolIntentChange}
      />
    </div>
  );
}
