import { ERROR_CODES } from '@mangostudio/shared/errors';
import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError } from '@/lib/utils';
import { useRevertChatFileCheckpoints } from '../hooks/use-chat-file-checkpoints';
import { RevertFileChangesDialog } from './RevertFileChangesDialog';

interface RevertFileChangesButtonProps {
  chatId: string;
  messageId: string;
}

type RevertErrorMessages = { conflict: string; outsideWorkdir: string; failed: string };

export function revertErrorMessage(error: unknown, labels: RevertErrorMessages): string {
  if (!(error instanceof ApiError)) return labels.failed;

  switch (error.code) {
    case ERROR_CODES.CONFLICT:
      return labels.conflict;
    // Revert re-checks containment against the chat workdir, so a turn that ran
    // before the restriction was enabled can fail here.
    case ERROR_CODES.PERMISSION_DENIED:
      return labels.outsideWorkdir;
    default:
      return labels.failed;
  }
}

/** Reverts filesystem mutations recorded for one assistant message. */
export function RevertFileChangesButton({ chatId, messageId }: RevertFileChangesButtonProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.chat.fileCheckpoints;
  const revert = useRevertChatFileCheckpoints(chatId);
  const [isConfirming, setIsConfirming] = useState(false);

  const handleConfirm = () => {
    revert.mutate(messageId, {
      onSuccess: (data) => {
        setIsConfirming(false);
        toast(labels.reverted.replace('{count}', String(data?.revertedFiles ?? 0)), 'success');
      },
      onError: (error) => {
        setIsConfirming(false);
        // The code is the contract; the server's own message is English-only and
        // must not reach the UI.
        toast(revertErrorMessage(error, labels), 'error');
      },
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsConfirming(true)}
        disabled={revert.isPending}
        className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] font-label uppercase tracking-wide text-on-surface-variant hover:text-primary disabled:opacity-40"
      >
        {revert.isPending ? labels.reverting : labels.revert}
      </button>
      {isConfirming && (
        <RevertFileChangesDialog
          isReverting={revert.isPending}
          onConfirm={handleConfirm}
          onCancel={() => setIsConfirming(false)}
        />
      )}
    </>
  );
}
