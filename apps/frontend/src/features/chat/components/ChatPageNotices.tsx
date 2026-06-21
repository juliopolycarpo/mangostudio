import type { FallbackNotice } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { ContextWarningCallout } from './ContextWarningCallout';

interface ChatFallbackNoticeProps {
  readonly notice: FallbackNotice;
}

export function ChatFallbackNotice({ notice }: ChatFallbackNoticeProps) {
  const { t } = useI18n();

  return (
    <div className="px-6 py-2 text-xs text-on-surface-variant bg-surface-container-low border-t border-outline-variant/10">
      <div className="mx-auto max-w-4xl">
        <div className="relative w-full pl-4 text-center" role="status" aria-live="polite">
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 -translate-y-1/2 text-on-surface-variant/60"
          >
            ・
          </span>
          {notice.to === 'replay'
            ? t.chat.fallback.toReplay
            : t.chat.fallback.generic.replace('{from}', notice.from).replace('{to}', notice.to)}
        </div>
      </div>
    </div>
  );
}

interface ChatContextDecisionNoticeProps {
  readonly warningMessage: string;
  readonly isPending: boolean;
  readonly onCompact: () => void;
  readonly onStartSummarizedChat: () => void;
  readonly onContinue: () => void;
}

export function ChatContextDecisionNotice({
  warningMessage,
  isPending,
  onCompact,
  onStartSummarizedChat,
  onContinue,
}: ChatContextDecisionNoticeProps) {
  const { t } = useI18n();

  return (
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
          isPending={isPending}
          onCompact={onCompact}
          onStartSummarizedChat={onStartSummarizedChat}
          onContinue={onContinue}
        />
      </div>
    </div>
  );
}
