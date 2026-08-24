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
 * one, kept small rather than grown into a component nobody asked for. What it
 * therefore has to carry itself is which dialog is on top when two of these are
 * open at once — see `engagedTraps`.
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

/**
 * Every engaged trap, oldest first, so the newest one owns the keyboard.
 *
 * `defaultPrevented` cannot decide this on its own. These listeners are all on
 * `document`, so they run in registration order — which is mount order, so the
 * dialog *underneath* answers first and prevents the event before the one on
 * top ever sees it. Escape would then close the background dialog and leave the
 * top one up, and the background's Tab handler would keep pulling at focus that
 * belongs to the dialog above it.
 *
 * The list is module-level because it is one keyboard: two hook instances in
 * unrelated trees still have exactly one topmost dialog between them. The
 * app-wide gates (`ExternalWorkspaceTrustGate`, `ExternalDisclosureGate`) mount
 * over whatever page is up, so this stacking is not hypothetical — a trust
 * prompt raised while the workdir picker is open is the reachable case.
 */
const engagedTraps: HTMLElement[] = [];

/** Notified whenever a trap engages — see `onFocusTrapEngaged`. */
const engagedListeners = new Set<() => void>();

/**
 * Runs when a trapped dialog engages, for overlays that are not traps themselves.
 *
 * The stack above settles who owns the keyboard between two traps, but the
 * command palette is deliberately not one: its a11y contract is the combobox
 * one, so focus stays in its input and the trap's "focus the dialog" step would
 * break it. That leaves it able to be *underneath* a trap in every sense except
 * paint order — an app-wide gate (`ExternalWorkspaceTrustGate`,
 * `ExternalDisclosureGate`) that mounts while the palette is open takes focus
 * and the keyboard, while the palette keeps rendering over it, so keystrokes
 * stop reaching the thing the user can see.
 *
 * No static z-order fixes that, because the reverse case is equally real: the
 * palette can be opened *over* an already-open gate, and there it belongs on
 * top. So the palette gets out of the way instead. Only a newly engaged trap
 * notifies, which is exactly the asymmetry — a gate already open when the
 * palette opens never fires.
 */
export function onFocusTrapEngaged(listener: () => void): () => void {
  engagedListeners.add(listener);
  return () => {
    engagedListeners.delete(listener);
  };
}

export function useFocusTrap(onEscape: () => void) {
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);

  // Keyed on the node alone. Folding this into the listener effect below would
  // let an `onEscape` whose identity changed on a re-render pop and re-push a
  // background dialog to the top of the stack, handing it a keyboard it is not
  // on top of — and would re-run the focus restore on every such render.
  useEffect(() => {
    if (!dialog) return;
    engagedTraps.push(dialog);
    // Restored on close, so dismissing the dialog puts the user back where they
    // were rather than at the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.focus();
    // Copied first: a listener that closes an overlay can unsubscribe another
    // one in the same tick, and mutating the set mid-iteration would skip it.
    for (const listener of [...engagedListeners]) listener();

    return () => {
      const index = engagedTraps.lastIndexOf(dialog);
      if (index >= 0) engagedTraps.splice(index, 1);
      previouslyFocused?.focus?.();
    };
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // A trapped dialog above this one owns the press, whether or not it has
      // had its own listener run yet.
      if (engagedTraps.at(-1) !== dialog) return;
      // Somebody above already answered this press. The listener is on
      // `document`, which every overlay in the app is a descendant of, so a
      // dialog opened *over* one of these — the command palette, say — handles
      // Escape at the React root and this listener still sees the same event on
      // its way up. The palette is not itself a trap, so it is not in the stack
      // above and this guard is the only thing that catches it: without it, one
      // press dismisses both the thing on top and the dialog it was covering.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      // A native control keeps its selector clause regardless of `tabIndex`, so
      // `<button tabIndex={-1}>` still matches `button:not([disabled])` — filter
      // those back out or Tab can walk past the last real stop and out of the
      // dialog.
      const focusable = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter(
        (element) => element.tabIndex >= 0
      );
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
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dialog, onEscape]);

  return setDialog;
}
