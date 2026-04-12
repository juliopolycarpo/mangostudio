import type { Connector } from '@mangostudio/shared';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface DeleteConfirmDialogProps {
  connector: Connector;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmDialog({ connector, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-sm rounded-3xl p-8 shadow-2xl border border-outline-variant/20 space-y-6">
        <div className="space-y-2 text-center">
          <div className="p-4 bg-error/10 rounded-full w-fit mx-auto text-error mb-2">
            <Trash2 size={32} />
          </div>
          <h3 className="text-xl font-bold text-on-surface">{s.deleteConnector}</h3>
          <p className="text-sm text-on-surface-variant/70">
            {s.deleteConfirm} <br />
            <span className="text-on-surface font-bold">&ldquo;{connector.name}&rdquo;</span>
          </p>
        </div>

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            {s.cancelButton}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            className="flex-1 bg-error hover:bg-error/80 shadow-error/20"
          >
            {s.deleteConnector}
          </Button>
        </div>
      </div>
    </div>
  );
}
