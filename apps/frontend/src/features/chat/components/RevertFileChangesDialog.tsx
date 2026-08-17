/**
 * Confirmation dialog for reverting one assistant message's file mutations
 * (mirrors the settings delete dialogs).
 */

import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-sm rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-5 sm:space-y-6">
        <div className="space-y-2 text-center">
          <div className="p-4 bg-error/10 rounded-full w-fit mx-auto text-error mb-2">
            <Undo2 size={32} />
          </div>
          <h3 className="text-xl font-bold text-on-surface">{labels.confirmTitle}</h3>
          <p className="text-sm text-on-surface-variant/70">{labels.confirmBody}</p>
        </div>

        {warning && (
          <div className="flex gap-2 rounded-2xl bg-error/10 p-3 text-left text-error">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p className="text-xs leading-relaxed">{warning}</p>
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            loading={isReverting}
            onClick={onConfirm}
            className="flex-1 bg-error hover:bg-error/80 shadow-error/20"
          >
            {labels.confirmAction}
          </Button>
        </div>
      </div>
    </div>
  );
}
