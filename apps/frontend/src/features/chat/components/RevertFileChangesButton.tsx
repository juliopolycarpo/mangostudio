import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError } from '@/lib/utils';
import { useRevertChatFileCheckpoints } from '../hooks/use-chat-file-checkpoints';
import { revertedMessage } from '../lib/uncheckpointed-copy';
import { RevertFileChangesDialog } from './RevertFileChangesDialog';

interface RevertFileChangesButtonProps {
  chatId: string;
  messageId: string;
  /**
   * From the preview, so the dialog can name what the revert will leave in
   * place before the user confirms.
   */
  uncheckpointedSources?: ReadonlyArray<UncheckpointedWriteSource>;
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
export function RevertFileChangesButton({
  chatId,
  messageId,
  uncheckpointedSources,
}: RevertFileChangesButtonProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.chat.fileCheckpoints;
  const revert = useRevertChatFileCheckpoints(chatId);
  const [isConfirming, setIsConfirming] = useState(false);

  const handleConfirm = () => {
    revert.mutate(messageId, {
      onSuccess: (data) => {
        setIsConfirming(false);
        // The server's own answer, not the preview: the turn may have run an
        // uncheckpointed tool after the list was last fetched.
        toast(
          revertedMessage(data?.revertedFiles ?? 0, data?.uncheckpointedSources ?? [], labels),
          'success'
        );
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
          uncheckpointedSources={uncheckpointedSources}
          onConfirm={handleConfirm}
          onCancel={() => setIsConfirming(false)}
        />
      )}
    </>
  );
}
