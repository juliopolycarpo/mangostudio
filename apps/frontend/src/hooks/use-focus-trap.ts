/**
 * Keyboard behaviour `aria-modal` does not supply.
 *
 * The attribute tells a screen reader the rest of the page is inert; it does
 * not move focus, keep Tab inside, or close on Escape. Without this a keyboard
 * user lands on whatever was focused before, tabs straight past the dialog into
 * the page behind it, and can reach the very control the dialog is gating.
 *
 * The ring is every tabbable descendant, not just the action buttons. A dialog
 * that skips its own controls is the same bug from the other side: `ConfirmDialog`
 * takes a checkbox through `children`, and a narrower ring leaves Shift+Tab from
 * that checkbox falling out of the dialog entirely. The links in the vendor
 * disclosure are in the cycle for the same reason — a trap that excludes them
 * makes "read the terms" unreachable while the thing gating it is on screen.
 *
 * There is no shared modal primitive in this app; this is the shared piece of
 * one, kept small rather than grown into a component nobody asked for.
 *
 * The ref is a callback (via `useState`), not a plain `useRef`. Every current
 * caller mounts fresh each time its dialog appears, but a caller that instead
 * stays mounted and toggles an `open` prop internally would have its div go
 * from absent to present on a re-render rather than a mount — a plain ref's
 * effect, keyed only on `onEscape`, would already have run once against a null
 * node and never fire again, so the trap would silently never engage past the
 * first render. Keying on the node itself re-runs the effect exactly when the
 * dialog actually appears, regardless of which pattern the caller uses.
 */

import { useEffect, useState } from 'react';

/** Tabbable, not merely focusable: `tabindex="-1"` is script focus, not a stop. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(onEscape: () => void) {
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    // Restored on close, so dismissing the dialog puts the user back where they
    // were rather than at the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // Somebody above already answered this press. The listener is on
      // `document`, which every overlay in the app is a descendant of, so a
      // dialog opened *over* one of these — the command palette, say — handles
      // Escape at the React root and this listener still sees the same event on
      // its way up. Without the guard, one press dismisses both the thing on
      // top and the dialog it was covering.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [dialog, onEscape]);

  return setDialog;
}
