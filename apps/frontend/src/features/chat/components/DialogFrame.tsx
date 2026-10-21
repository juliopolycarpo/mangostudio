import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * The shell the chat's modal dialogs share: a flat `scrim` over the page and a
 * `surface-raised` panel — hairline, `rounded-lg`, `shadow-dialog`, no blur —
 * built the way `ConfirmDialog` is, so a dialog raised from the composer reads
 * as the same object as one raised from settings.
 *
 * Everything on the props goes to the panel (`role`, `aria-label`, a focus-trap
 * `ref`), and `className` sets its width. The body and the footer come from
 * {@link DialogBody} and {@link DialogFooter}; a form dialog wraps both in its
 * `<form>` so the footer's submit button still submits it.
 *
 * // Usage: <DialogFrame role="dialog" aria-modal="true"><DialogBody>…</DialogBody><DialogFooter>…</DialogFooter></DialogFrame>
 */
export function DialogFrame({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 animate-in fade-in duration-200">
      <div
        className={cn(
          'w-full max-w-sm rounded-lg border border-stroke bg-surface-raised shadow-dialog',
          className
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

/** The dialog's content: a left-aligned title, then what it says, at dialog padding. */
export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('space-y-4 p-6', className)} {...props} />;
}

/** The actions, right-aligned at natural width on `canvas`: the quiet one first, the verb last. */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex justify-end gap-2 rounded-b-lg border-t border-stroke bg-canvas px-6 py-4',
        className
      )}
      {...props}
    />
  );
}
