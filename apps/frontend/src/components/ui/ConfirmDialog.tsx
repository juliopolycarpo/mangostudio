import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

interface ConfirmDialogProps {
  readonly title: string;
  readonly description: string;
  /** The thing the question is about, quoted under the sentence. Omit when the title names it. */
  readonly entityName?: string;
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
 * A `Dialog` at its smallest size, so the keyboard contract is the shared one:
 * focus lands on "Cancel" — the safe answer to a question that deletes
 * something — Tab cycles the dialog's own controls (the two buttons plus
 * anything `children` contributes) instead of walking into the page behind
 * them, Escape and a click on the backdrop cancel, and focus goes back to
 * whatever opened it. While the request is in flight there is nothing to take
 * back yet, so Escape and the backdrop wait, as the disabled Cancel does.
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
  return (
    <Dialog
      size="sm"
      title={title}
      description={
        <>
          {description}
          {entityName ? (
            <>
              <br />
              <span className="font-medium text-fg">&ldquo;{entityName}&rdquo;</span>
            </>
          ) : null}
        </>
      }
      onClose={onCancel}
      closeDisabled={isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={isPending} autoFocus>
            {cancelLabel}
          </Button>
          <Button variant="danger" loading={isPending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
