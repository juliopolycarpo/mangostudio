import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface DeleteAgentDialogProps {
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly deletingLabel: string;
  readonly isOpen: boolean;
  readonly isDeleting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteAgentDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  deletingLabel,
  isOpen,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteAgentDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl border border-stroke bg-canvas p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-fg">{title}</h3>
            <p className="text-sm text-fg-muted">{description}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1 text-fg-muted hover:bg-fill-hover"
            aria-label={cancelLabel}
          >
            <X size={18} />
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="subtle" onClick={onCancel} disabled={isDeleting}>
            {cancelLabel}
          </Button>
          <Button type="button" variant="primary" loading={isDeleting} onClick={onConfirm}>
            <Trash2 size={16} />
            {isDeleting ? deletingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
