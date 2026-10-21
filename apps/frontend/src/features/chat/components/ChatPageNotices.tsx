import { Callout } from '@/components/ui/Callout';
import type { FallbackNotice } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { ContextWarningCallout } from './ContextWarningCallout';

interface ChatFallbackNoticeProps {
  readonly notice: FallbackNotice;
}

export function ChatFallbackNotice({ notice }: ChatFallbackNoticeProps) {
  const { t } = useI18n();

  return (
    <div className="px-6 pt-4">
      <div className="mx-auto max-w-4xl">
        <Callout tone="info" role="status" aria-live="polite">
          {notice.to === 'replay'
            ? t.chat.fallback.toReplay
            : t.chat.fallback.generic.replace('{from}', notice.from).replace('{to}', notice.to)}
        </Callout>
      </div>
    </div>
  );
}

interface ChatContextDecisionNoticeProps {
  readonly warningMessage: string;
  readonly isPending: boolean;
  /** The model has not resolved: Compact and New chat wait, Continue does not. */
  readonly isModelResolving?: boolean;
  readonly onCompact: () => void;
  readonly onStartSummarizedChat: () => void;
  readonly onContinue: () => void;
}

export function ChatContextDecisionNotice({
  warningMessage,
  isPending,
  isModelResolving = false,
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
          modelActionsDisabled={isModelResolving}
          onCompact={onCompact}
          onStartSummarizedChat={onStartSummarizedChat}
          onContinue={onContinue}
        />
      </div>
    </div>
  );
}
