import { type FormEventHandler, type ReactNode, useCallback, useId, useRef } from 'react';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { cn } from '@/lib/utils';

/**
 * What every floating panel in the app is made of: `surface-raised`, a hairline,
 * `rounded-lg` and the dialog elevation. `Dialog` wears it, and so does the
 * command palette, which keeps its own panel (a combobox that must leave focus
 * in its input) but is the same kind of object.
 */
export const DIALOG_SURFACE_CLASS =
  'rounded-lg border border-stroke bg-surface-raised shadow-dialog';

/**
 * `sm` is a question (a sentence and two buttons), `md` carries a form or a
 * short list, `lg` carries a list of steps, a table of commands or a wizard.
 */
type DialogSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
};

/** Either a visible title names the dialog, or an explicit label does. Never neither. */
type DialogName =
  | {
      /** The visible title. It is also the dialog's accessible name (`aria-labelledby`). */
      readonly title: ReactNode;
      readonly ariaLabel?: never;
    }
  | {
      readonly title?: never;
      /** The accessible name of a dialog that has no visible title (a progress view). */
      readonly ariaLabel: string;
    };

type DialogProps = DialogName & {
  readonly size?: DialogSize;
  /** A line above the title: the machine a picker is browsing. */
  readonly eyebrow?: ReactNode;
  /** Leads the title row: the avatar the identity dialog previews. */
  readonly leading?: ReactNode;
  /** One muted sentence under the title. */
  readonly description?: ReactNode;
  /** A control on the title line: the close button of a dialog that has no Cancel. */
  readonly headerAction?: ReactNode;
  /** Truncate the title to one line, for a title that carries a user's own text. */
  readonly truncateTitle?: boolean;
  /** Pinned between the header and the scrolling body: a search field, a step bar. */
  readonly toolbar?: ReactNode;
  /** An inline `Callout` between the body and the footer, so a failure stays in view. */
  readonly notice?: ReactNode;
  /**
   * The actions, right-aligned at natural width on `canvas`: the quiet one
   * first, the primary last. A note to the left of them (a reason, an error) is
   * a `flex-1` child of the footer content.
   */
  readonly footer?: ReactNode;
  /**
   * The body is a layout of its own — panes with their own dividers and scroll
   * regions — so it gets no padding, no spacing and no scroll, and the header
   * grows a hairline under it to match the footer's.
   */
  readonly flush?: boolean;
  /**
   * Wraps the header, body and footer in a `<form>`, so the footer's submit
   * button submits it. The handler is passed through untouched: it calls
   * `preventDefault` itself.
   */
  readonly onSubmit?: FormEventHandler<HTMLFormElement>;
  /** Escape and a click on the backdrop. Not called while `closeDisabled`. */
  readonly onClose: () => void;
  /**
   * Escape and the backdrop do nothing, as the disabled Cancel button does:
   * a write is in flight, or a progress view has no way back yet.
   */
  readonly closeDisabled?: boolean;
  /** On the backdrop, which is what the overlay tests query. */
  readonly testId?: string;
  /** The body. It scrolls when the dialog outgrows the viewport. */
  readonly children?: ReactNode;
};

/**
 * The modal frame every dialog in the app shares: a flat `scrim`, a
 * `surface-raised` panel with a title, a scrolling body and a footer on
 * `canvas`, and the keyboard contract `aria-modal` does not supply.
 *
 * That contract is `useFocusTrap`'s: focus moves in (unless a control inside
 * already took it, as `autoFocus` does), Tab stays inside, Escape closes and
 * focus goes back to whatever opened it. A click on the backdrop closes the same
 * way — but only a press that began on the backdrop, so selecting text in a
 * field and letting go outside the panel does not discard the form.
 *
 * Presentation and behaviour only: what the dialog says, and what its buttons
 * do, stays with the caller. Escape and the backdrop go through `onClose`, so a
 * dialog whose Cancel does more than hide it passes that same handler.
 *
 * // Usage:
 * <Dialog title={s.title} description={s.hint} onClose={close} footer={<Button onClick={close}>{s.done}</Button>}>…</Dialog>
 */
export function Dialog({
  title,
  ariaLabel,
  size = 'md',
  eyebrow,
  leading,
  description,
  headerAction,
  truncateTitle = false,
  toolbar,
  notice,
  footer,
  flush = false,
  onSubmit,
  onClose,
  closeDisabled = false,
  testId,
  children,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  // Read through refs so the escape handler keeps one identity: the trap
  // re-registers its listener whenever it changes, and a dialog that re-renders
  // while a write is in flight would otherwise churn it on every keystroke.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
  const requestClose = useCallback(() => {
    if (closeDisabledRef.current) return;
    onCloseRef.current();
  }, []);
  const dialogRef = useFocusTrap(requestClose);
  // A click lands on the nearest common ancestor of where the press began and
  // ended, so dragging a text selection out of the panel yields a click on the
  // backdrop itself. Remember where the press began.
  const pressBeganInPanel = useRef(false);

  const hasTitle = title !== undefined;
  const hasBody = Boolean(children);
  const hasFooter = Boolean(footer);

  const sections = (
    <>
      {hasTitle ? (
        <header
          className={cn(
            'flex shrink-0 items-start justify-between gap-4 px-6 pt-6',
            flush ? 'border-b border-stroke pb-4' : !hasBody && !toolbar && 'pb-6'
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            {leading}
            <div className="min-w-0 space-y-1">
              {eyebrow}
              <h2
                id={titleId}
                className={cn('text-title font-semibold text-fg', truncateTitle && 'truncate')}
              >
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="text-sm text-fg-muted">
                  {description}
                </p>
              ) : null}
            </div>
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </header>
      ) : null}

      {toolbar ? <div className="shrink-0 px-6 pt-4">{toolbar}</div> : null}

      {hasBody ? (
        flush ? (
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        ) : (
          <div
            className={cn(
              'app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6',
              hasTitle || toolbar ? 'pt-4' : 'pt-6',
              hasFooter || notice ? 'pb-4' : 'pb-6'
            )}
          >
            {children}
          </div>
        )
      ) : null}

      {notice ? <div className="shrink-0 px-6 pb-4">{notice}</div> : null}

      {hasFooter ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-stroke bg-canvas px-6 py-4">
          {footer}
        </footer>
      ) : null}
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only dismisses; Escape, handled by the focus trap, is its keyboard equivalent.
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — the key is Escape, on the document.
    <div
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-scrim p-4 fade-in duration-200"
      data-testid={testId}
      onMouseDown={(event) => {
        pressBeganInPanel.current = event.target !== event.currentTarget;
      }}
      onClick={(event) => {
        // Only the backdrop itself, never a click bubbled up from the panel.
        if (event.target !== event.currentTarget) return;
        if (pressBeganInPanel.current) {
          pressBeganInPanel.current = false;
          return;
        }
        requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hasTitle ? titleId : undefined}
        aria-label={hasTitle ? undefined : ariaLabel}
        // The sentence under the title is read with the name: for a confirmation
        // it is the question itself, not decoration.
        aria-describedby={hasTitle && description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'flex max-h-full w-full flex-col overflow-hidden text-sm text-fg outline-none',
          DIALOG_SURFACE_CLASS,
          SIZE_CLASS[size]
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
