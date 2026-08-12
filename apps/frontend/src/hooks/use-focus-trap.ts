/**
 * Keyboard behaviour `aria-modal` does not supply.
 *
 * The attribute tells a screen reader the rest of the page is inert; it does
 * not move focus, keep Tab inside, or close on Escape. Without this a keyboard
 * user lands on whatever was focused before, tabs straight past the dialog into
 * the page behind it, and can reach the very control the dialog is gating.
 *
 * Buttons only, deliberately. Every dialog using this puts its actions on
 * buttons, and widening the ring to links would pull a "read the vendor's
 * terms" anchor into the cycle ahead of the accept and cancel controls that
 * dismiss it.
 *
 * There is no shared modal primitive in this app; this is the shared piece of
 * one, kept small rather than grown into a component nobody asked for.
 */

import { useEffect, useRef } from 'react';

export function useFocusTrap(onEscape: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Restored on close, so dismissing the dialog puts the user back where they
    // were rather than at the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
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
  }, [onEscape]);

  return ref;
}
