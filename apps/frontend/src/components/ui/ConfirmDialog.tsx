import { Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { useFocusTrap } from '@/hooks/use-focus-trap';

interface ConfirmDialogProps {
  readonly title: string;
  readonly description: string;
  readonly entityName: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly isPending?: boolean;
  /** Optional extra controls (e.g. a checkbox) between the copy and the buttons. */
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Destructive-confirm overlay used by settings delete/revoke flows.
 *
 * The keyboard contract is the shared one the vendor dialogs already use: focus
 * moves in, Tab cycles the two buttons instead of walking into the page behind
 * them, Escape cancels, and focus goes back to whatever opened it. A dialog
 * gating a delete is the last place a keyboard user should be able to tab
 * straight past onto the control it is gating.
 *
 * Usage: <ConfirmDialog title={…} description={…} entityName={name} … />
 */
export function ConfirmDialog({
  title,
  description,
  entityName,
  confirmLabel,
  cancelLabel,
  isPending = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Read through refs so the escape handler's identity never changes: the trap
  // re-registers its listener and re-focuses the dialog whenever it does, which
  // on a dialog that re-renders while pending would keep yanking focus off the
  // button the user is on.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;
  const handleEscape = useCallback(() => {
    // The same rule the disabled Cancel button follows: a request is in flight,
    // and there is nothing to take back yet.
    if (isPendingRef.current) return;
    onCancelRef.current();
  }, []);
  const dialogRef = useFocusTrap(handleEscape);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="bg-surface-container-high w-full max-w-sm rounded-2xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-5 sm:space-y-6 outline-none"
      >
        <div className="space-y-2 text-center">
          <div className="p-4 bg-error/10 rounded-full w-fit mx-auto text-error mb-2">
            <Trash2 size={32} />
          </div>
          <h3 className="text-xl font-bold text-on-surface">{title}</h3>
          <p className="text-sm text-on-surface-variant/70">
            {description} <br />
            <span className="text-on-surface font-bold">&ldquo;{entityName}&rdquo;</span>
          </p>
        </div>

        {children}

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel} className="flex-1" disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            loading={isPending}
            onClick={onConfirm}
            className="flex-1 bg-error hover:bg-error/80 shadow-error/20"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
