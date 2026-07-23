import { useI18n } from '@/hooks/use-i18n';
import { useRevertChatFileCheckpoints } from '../hooks/use-chat-file-checkpoints';

interface RevertFileChangesButtonProps {
  chatId: string;
  messageId: string;
}

/** Reverts filesystem mutations recorded for one assistant message. */
export function RevertFileChangesButton({ chatId, messageId }: RevertFileChangesButtonProps) {
  const { t } = useI18n();
  const labels = t.chat.fileCheckpoints;
  const revert = useRevertChatFileCheckpoints(chatId);

  const handleClick = () => {
    if (!window.confirm(`${labels.confirmTitle}\n\n${labels.confirmBody}`)) return;
    revert.mutate(messageId, {
      onError: (error) => {
        const message =
          error instanceof Error && error.message.includes('changed on disk')
            ? labels.conflict
            : error instanceof Error
              ? error.message
              : labels.failed;
        window.alert(message);
      },
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={revert.isPending}
      className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] font-label uppercase tracking-wide text-on-surface-variant hover:text-primary disabled:opacity-40"
    >
      {revert.isPending ? labels.reverting : labels.revert}
    </button>
  );
}
