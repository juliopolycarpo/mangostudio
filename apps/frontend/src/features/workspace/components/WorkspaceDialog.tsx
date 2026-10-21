/**
 * The frame every Repository-panel dialog shares: a flat `scrim`, a
 * `surface-raised` panel with `rounded-lg` and `shadow-dialog`, a title, a body
 * and a footer on `canvas` with the actions right-aligned at natural width —
 * the quiet one first, the primary or destructive one last.
 *
 * Presentation only. Seven dialogs (discard, branch rename/delete/blocked
 * checkout, amend, message overwrite, force push, stashes) each drew this frame
 * by hand; none of them owns a keyboard contract this would change.
 *
 * Pass `onSubmit` for a dialog that is a form: the sections are wrapped in a
 * `<form>` so the footer's submit button submits it.
 *
 * // Usage:
 * <WorkspaceDialog titleId={id} title={labels.title} footer={<Button>…</Button>}>…</WorkspaceDialog>
 */

import type { FormEventHandler, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface WorkspaceDialogProps {
  /** Ties the panel's accessible name to the visible title. */
  readonly titleId: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** A control on the title line: the close button of a dialog with no Cancel. */
  readonly headerAction?: ReactNode;
  /** `sm` for a question, `md` for a dialog that carries a form and a list. */
  readonly size?: 'sm' | 'md';
  readonly onSubmit?: FormEventHandler<HTMLFormElement>;
  /** The actions: the quiet one first, the primary last. Omit for a close-button dialog. */
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}

export function WorkspaceDialog({
  titleId,
  title,
  description,
  headerAction,
  size = 'sm',
  onSubmit,
  footer,
  children,
}: WorkspaceDialogProps) {
  const sections = (
    <>
      <header
        className={cn(
          'flex shrink-0 items-start justify-between gap-4 px-6 pt-6',
          children ? null : 'pb-6'
        )}
      >
        <div className="min-w-0 space-y-1">
          <h3 id={titleId} className="text-title font-semibold text-fg">
            {title}
          </h3>
          {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </header>
      {children ? (
        <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-4 pb-6">
          {children}
        </div>
      ) : null}
      {footer ? (
        <footer className="flex shrink-0 justify-end gap-2 border-t border-stroke bg-canvas px-6 py-4">
          {footer}
        </footer>
      ) : null}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-scrim p-4 fade-in duration-200">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-stroke bg-surface-raised shadow-dialog',
          size === 'sm' ? 'max-w-sm' : 'max-w-md'
        )}
      >
        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            {sections}
          </form>
        ) : (
          sections
        )}
      </div>
    </div>
  );
}

/**
 * A quoted value inside a dialog — the branch about to be deleted, the stash
 * about to be dropped. Mono on `canvas`, the same recess a tool block's output
 * sits in, so the thing the question is about reads as data and not as prose.
 */
export function DialogCodeBlock({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-stroke bg-canvas p-2 font-mono text-xs text-fg',
        className
      )}
    >
      {children}
    </div>
  );
}

/** The paths a dialog is about to act on, one per line, scrolling past a handful. */
export function DialogPathList({ paths }: { readonly paths: readonly string[] }) {
  return (
    <DialogCodeBlock className="app-scrollbar max-h-32 overflow-y-auto">
      <ul>
        {paths.map((path) => (
          <li key={path} className="truncate py-0.5" title={path}>
            {path}
          </li>
        ))}
      </ul>
    </DialogCodeBlock>
  );
}
