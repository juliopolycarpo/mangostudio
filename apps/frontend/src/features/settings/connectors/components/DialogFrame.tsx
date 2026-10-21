import { type ReactNode, useCallback, useRef } from 'react';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { cn } from '@/lib/utils';

interface DialogFrameProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** `sm` is a confirmation (a sentence and two buttons); `md` carries a form or a list. */
  readonly size?: 'sm' | 'md';
  /** A control on the title line: the close button of a dialog that has no Cancel. */
  readonly headerAction?: ReactNode;
  /** Pinned between the title and the scrolling body — a search field. */
  readonly toolbar?: ReactNode;
  /** An inline `Callout` outside the scrolling body, so a failure stays in view. */
  readonly notice?: ReactNode;
  /** The actions, right-aligned at natural width: the quiet one first, the primary last. */
  readonly footer: ReactNode;
  /** Escape. */
  readonly onClose: () => void;
  /** Escape does nothing while a write is in flight, as the disabled Cancel button does. */
  readonly closeDisabled?: boolean;
  /** The body. It scrolls when the dialog outgrows the viewport. */
  readonly children?: ReactNode;
}

/**
 * The frame the settings dialogs share: a flat `scrim`, a `surface-raised`
 * panel with `rounded-lg` and `shadow-dialog`, a title, a scrolling body and a
 * footer on `canvas`. It is `ConfirmDialog`'s frame for the dialogs that carry
 * more than a sentence, with the same keyboard contract: focus moves in, Tab
 * stays inside, Escape closes and focus goes back to what opened it.
 *
 * // Usage:
 * <DialogFrame title={s.title} footer={<Button onClick={onClose}>{s.done}</Button>} onClose={onClose}>…</DialogFrame>
 */
export function DialogFrame({
  title,
  description,
  size = 'md',
  headerAction,
  toolbar,
  notice,
  footer,
  onClose,
  closeDisabled = false,
  children,
}: DialogFrameProps) {
  // Read through refs so the escape handler keeps one identity: the trap
  // re-registers and re-focuses the dialog whenever it changes, which would
  // yank focus off the field being typed in on every re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
  const handleEscape = useCallback(() => {
    if (closeDisabledRef.current) return;
    onCloseRef.current();
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
        className={cn(
          'flex max-h-[90vh] w-full flex-col rounded-lg border border-stroke bg-surface-raised shadow-dialog outline-none',
          size === 'sm' ? 'max-w-sm' : 'max-w-lg'
        )}
      >
        <div
          className={cn(
            'flex shrink-0 items-start justify-between gap-4 px-6 pt-6',
            !children && !toolbar && 'pb-6'
          )}
        >
          <div className="min-w-0 space-y-2">
            <h3 className="text-title font-semibold text-fg">{title}</h3>
            {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>

        {toolbar ? <div className="shrink-0 px-6 pt-4">{toolbar}</div> : null}

        {children ? (
          <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6 pt-4">
            {children}
          </div>
        ) : null}

        {notice ? <div className="shrink-0 px-6 pb-4">{notice}</div> : null}

        <div className="flex shrink-0 justify-end gap-2 rounded-b-lg border-t border-stroke bg-canvas px-6 py-4">
          {footer}
        </div>
      </div>
    </div>
  );
}
