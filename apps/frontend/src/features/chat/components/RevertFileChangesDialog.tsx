/**
 * Confirmation dialog for reverting one assistant message's file mutations
 * (mirrors the settings delete dialogs).
 */

import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { useI18n } from '@/hooks/use-i18n';
import { uncheckpointedWarning } from '../lib/uncheckpointed-copy';

interface RevertFileChangesDialogProps {
  isReverting: boolean;
  /** Classes of write this turn made that the revert will leave in place. */
  uncheckpointedSources?: ReadonlyArray<UncheckpointedWriteSource>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RevertFileChangesDialog({
  isReverting,
  uncheckpointedSources,
  onConfirm,
  onCancel,
}: RevertFileChangesDialogProps) {
  const { t } = useI18n();
  const labels = t.chat.fileCheckpoints;
  const warning = uncheckpointedWarning(uncheckpointedSources ?? [], labels);

  return (
    <Dialog
      size="sm"
      title={labels.confirmTitle}
      description={labels.confirmBody}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {labels.cancel}
          </Button>
          <Button variant="danger" loading={isReverting} onClick={onConfirm}>
            {labels.confirmAction}
          </Button>
        </>
      }
    >
      {warning && <Callout tone="warning" title={warning} />}
    </Dialog>
  );
}
