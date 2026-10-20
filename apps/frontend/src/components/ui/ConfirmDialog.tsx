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
 * moves in, Tab cycles the dialog's own controls — the two buttons plus anything
 * `children` contributes — instead of walking into the page behind them, Escape
 * cancels, and focus goes back to whatever opened it. A dialog gating a delete
 * is the last place a keyboard user should be able to tab straight past onto the
 * control it is gating.
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg border border-stroke bg-surface-raised shadow-dialog outline-none"
      >
        <div className="space-y-2 p-6">
          <h3 className="text-title font-semibold text-fg">{title}</h3>
          <p className="text-sm text-fg-muted">
            {description} <br />
            <span className="font-medium text-fg">&ldquo;{entityName}&rdquo;</span>
          </p>
          {children}
        </div>

        <div className="flex justify-end gap-2 rounded-b-lg border-t border-stroke bg-canvas px-6 py-4">
          <Button variant="secondary" onClick={onCancel} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button variant="danger" loading={isPending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
