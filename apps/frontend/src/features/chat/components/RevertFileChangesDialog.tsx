/**
 * Confirmation dialog for reverting one assistant message's file mutations
 * (mirrors the settings delete dialogs).
 */

import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface RevertFileChangesDialogProps {
  isReverting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RevertFileChangesDialog({
  isReverting,
  onConfirm,
  onCancel,
}: RevertFileChangesDialogProps) {
  const { t } = useI18n();
  const labels = t.chat.fileCheckpoints;

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
