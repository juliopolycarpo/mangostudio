import type { Message } from '@mangostudio/shared';
import type { Messages } from '@mangostudio/shared/i18n';
import { format } from 'date-fns';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { CopyMessageButton } from './CopyMessageButton';
import { RevertFileChangesButton } from './RevertFileChangesButton';

type FeedLabels = Messages['chat']['feed'];

interface AssistantMessageHeaderProps {
  msg: Message;
  isImageTurn: boolean;
  chatId?: string | null;
  canRevertFileChanges?: boolean;
}

/** Picks the status verb shown next to the model name for an assistant turn. */
function statusVerb(msg: Message, isImageTurn: boolean, labels: FeedLabels): string {
  if (msg.isGenerating) return isImageTurn ? labels.statusGenerating : labels.statusThinking;
  return isImageTurn ? labels.statusGenerated : labels.statusReplied;
}

/**
 * Renders the assistant turn header: avatar, model status, copy action, and the
 * timestamp (shown for completed turns).
 *
 * Usage: <AssistantMessageHeader msg={msg} isImageTurn={isImageTurn} />
 */
export function AssistantMessageHeader({
  msg,
  isImageTurn,
  chatId,
  canRevertFileChanges,
}: AssistantMessageHeaderProps) {
  const { t } = useI18n();
  const labels = t.chat.feed;
  const statusLabel = msg.modelName
    ? labels.modelStatus
        .replace('{status}', statusVerb(msg, isImageTurn, labels))
        .replace('{model}', () => msg.modelName ?? '')
    : labels.modelFallback;

  return (
    <div className="flex items-center gap-3">
      <div className="w-6 h-6 rounded-full bg-primary-container flex items-center justify-center">
        <Sparkles size={14} className="text-on-primary" />
      </div>
      <span className="text-xs font-bold font-headline tracking-wide uppercase text-primary">
        {statusLabel}
      </span>
      {!msg.isGenerating && !isImageTurn && (
        <CopyMessageButton
          msg={msg}
          label={t.chat.copyMessage}
          copiedLabel={t.chat.messageCopied}
        />
      )}
      {!msg.isGenerating && !isImageTurn && chatId && canRevertFileChanges && (
        <RevertFileChangesButton chatId={chatId} messageId={msg.id} />
      )}
      {!msg.isGenerating && (
        <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] text-on-surface-variant/50 font-label ml-auto">
          {format(msg.timestamp, 'h:mm a')}
        </span>
      )}
    </div>
  );
}
