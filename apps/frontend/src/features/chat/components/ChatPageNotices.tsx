import type { ComponentProps } from 'react';
import { Callout } from '@/components/ui/Callout';
import type { FallbackNotice } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { CHAT_COLUMN_CLASS, CHAT_GUTTER_X_CLASS } from '../lib/chat-column';
import { ContextWarningCallout } from './ContextWarningCallout';

/**
 * The row every block above the composer sits in: the notices and the pinned
 * todos.
 *
 * One wrapper so a stack of them shares a left edge, a top gap and the
 * composer's own gutter ladder (`px-3 sm:px-4 md:px-6`) instead of each notice
 * guessing its own; the inner column is the one the transcript and the composer
 * use. Attributes pass through to the row, so a notice that is a live region as
 * a whole (rather than through its `Callout`) can say so.
 *
 * // Usage: <ChatDockNotice><Callout tone="info">…</Callout></ChatDockNotice>
 */
export function ChatDockNotice({ children, ...props }: Omit<ComponentProps<'div'>, 'className'>) {
  return (
    <div className={`${CHAT_GUTTER_X_CLASS} pt-3`} {...props}>
      <div className={CHAT_COLUMN_CLASS}>{children}</div>
    </div>
  );
}

interface ChatFallbackNoticeProps {
  readonly notice: FallbackNotice;
}

export function ChatFallbackNotice({ notice }: ChatFallbackNoticeProps) {
  const { t } = useI18n();

  return (
    <ChatDockNotice>
      <Callout tone="info" role="status" aria-live="polite">
        {notice.to === 'replay'
          ? t.chat.fallback.toReplay
          : t.chat.fallback.generic.replace('{from}', notice.from).replace('{to}', notice.to)}
      </Callout>
    </ChatDockNotice>
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
    <ChatDockNotice>
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
    </ChatDockNotice>
  );
}
