/**
 * The frame the external-agent dialogs share: a flat `scrim`, a `surface-raised`
 * panel with `rounded-lg` and `shadow-dialog`, a title, a scrolling body and a
 * footer on `canvas` with the actions right-aligned at natural width.
 *
 * Presentation only. The caller owns the keyboard contract — it passes the ref
 * `useFocusTrap` returns, so focus, Tab and Escape behave exactly as they did
 * when each dialog drew its own frame.
 *
 * // Usage:
 * <ExternalDialog dialogRef={ref} label={labels.title} title={labels.title} footer={<Button>…</Button>}>…</ExternalDialog>
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ExternalDialogProps {
  /** The callback ref `useFocusTrap` returns. */
  readonly dialogRef: (node: HTMLDivElement | null) => void;
  /** The dialog's accessible name. */
  readonly label: string;
  readonly title: string;
  readonly description?: string;
  /** `lg` carries a list the user chooses from. */
  readonly size?: 'md' | 'lg';
  /** The actions: the quiet one first, the primary last. */
  readonly footer: ReactNode;
  readonly children: ReactNode;
}

export function ExternalDialog({
  dialogRef,
  label,
  title,
  description,
  size = 'md',
  footer,
  children,
}: ExternalDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={label}
        className={cn(
          'flex max-h-[80vh] w-full flex-col overflow-hidden rounded-lg border border-stroke bg-surface-raised text-sm text-fg shadow-dialog outline-none',
          size === 'md' ? 'max-w-lg' : 'max-w-xl'
        )}
      >
        <header className="shrink-0 space-y-1 px-6 pt-6">
          <h2 className="text-title font-semibold text-fg">{title}</h2>
          {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
        </header>

        <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {children}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-stroke bg-canvas px-6 py-4">
          {footer}
        </footer>
      </div>
    </div>
  );
}
