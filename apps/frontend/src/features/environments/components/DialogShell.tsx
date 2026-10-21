/**
 * The frame the environments dialogs share: a flat `scrim`, a `surface-raised`
 * panel with `rounded-lg` and `shadow-dialog`, a title, a scrolling body and a
 * footer on `canvas` with the actions right-aligned at natural width.
 *
 * Presentation only. Each dialog keeps its own keyboard contract — the overlay
 * hands `onKeyDown` through for the ones that delegate Escape from whatever
 * inside holds focus — so wrapping a dialog in this changes how it looks, never
 * how it behaves.
 *
 * // Usage:
 * <DialogShell titleId={id} title={labels.title} footer={<Button>…</Button>}>…</DialogShell>
 */

import type { KeyboardEventHandler, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface DialogShellProps {
  /** Ties the panel's accessible name to the visible title. */
  readonly titleId: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Leads the title row — the avatar the identity dialog previews. */
  readonly leading?: ReactNode;
  /** A control on the title line: the close button of a dialog with no Cancel. */
  readonly headerAction?: ReactNode;
  /** Extra classes for the title, e.g. `truncate` when it carries a user's text. */
  readonly titleClassName?: string;
  /** `md` carries a form; `lg` carries a list of steps and their commands. */
  readonly size?: 'md' | 'lg';
  readonly testId?: string;
  /** Escape delegated from the overlay to whatever inside it holds focus. */
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  /** The actions: the quiet one first, the primary last. */
  readonly footer: ReactNode;
  readonly children: ReactNode;
}

export function DialogShell({
  titleId,
  title,
  description,
  leading,
  headerAction,
  titleClassName,
  size = 'md',
  testId,
  onKeyDown,
  footer,
  children,
}: DialogShellProps) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is delegated from the overlay to whatever inside it holds focus.
    <div
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-scrim p-4 fade-in duration-200"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-stroke bg-surface-raised shadow-dialog',
          size === 'md' ? 'max-w-md' : 'max-w-2xl'
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
          <div className="flex min-w-0 items-center gap-3">
            {leading}
            <div className="min-w-0 space-y-1">
              <h3 id={titleId} className={cn('text-title font-semibold text-fg', titleClassName)}>
                {title}
              </h3>
              {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
            </div>
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </header>

        <div className="app-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {children}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-stroke bg-canvas px-6 py-4">
          {footer}
        </footer>
      </div>
    </div>
  );
}
