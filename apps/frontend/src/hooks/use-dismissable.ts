/**
 * How a hand-rolled popover closes: a press anywhere outside it, or Escape
 * while focus is inside it.
 *
 * The composer grew five of these by hand (`ModelSelector`, `PermissionSelector`,
 * `RunnerSelector`, `McpComposerMenu`, `CapabilityInspector`), and they did not
 * agree: two closed on an outside press and ignored Escape, one did both, and
 * two did neither and could only be closed by their own trigger — so a panel
 * left open sat on top of the status line and the draft until you found the
 * button again. One hook means one gesture does one thing.
 *
 * Escape is handled on the container (`onKeyDown`), not on `document`, for the
 * same reason `Menu` and `useListboxSelect` do it that way: the innermost layer
 * is the one the user meant to dismiss. The container's handler stops the key
 * before it reaches a surrounding dialog's `document` listener, and it only
 * hears keys from inside itself, so an Escape typed in the textarea (the slash
 * palette's) or in a dialog opened from a popover is never swallowed.
 *
 * Focus goes back to the trigger on Escape only. A press outside is the user
 * moving somewhere else on purpose — the textarea, another chip — and pulling
 * focus back to the trigger would undo exactly that.
 *
 * // Usage:
 * const { containerRef, triggerRef, onKeyDown } = useDismissable(open, () => setOpen(false));
 * <div ref={containerRef} onKeyDown={onKeyDown}><button ref={triggerRef} />…</div>
 */

import { type KeyboardEvent, type RefObject, useEffect, useRef } from 'react';

interface Dismissable<Container extends HTMLElement> {
  /** The element wrapping the trigger and its panel: a press outside it dismisses. */
  readonly containerRef: RefObject<Container | null>;
  /** The control that opens the panel: Escape returns focus to it. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  /** The container's `onKeyDown`: Escape closes the panel and keeps the key to itself. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useDismissable<Container extends HTMLElement = HTMLDivElement>(
  open: boolean,
  close: () => void
): Dismissable<Container> {
  const containerRef = useRef<Container>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Read through a ref so the listener keeps one identity per opening: callers
  // pass an inline closure, and re-registering on every render would churn it.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) closeRef.current();
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    closeRef.current();
    triggerRef.current?.focus();
  };

  return { containerRef, triggerRef, onKeyDown };
}
