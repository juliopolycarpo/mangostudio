/**
 * Viewport coordinates for a popup that must escape its scroll container.
 *
 * A panel positioned `absolute` inside its trigger's wrapper is clipped by any
 * ancestor that scrolls or hides overflow. Settings pickers live in exactly
 * such ancestors — the import and API-key dialogs are `max-h-[90vh]
 * overflow-y-auto` — so a list opened near the bottom of one was cut off at the
 * dialog edge, with its lower rows unreachable. The native `<select>` popup
 * never had this problem because the platform drew it outside the document.
 *
 * The equivalent here is to render the panel into `document.body` and place it
 * by hand. This hook is the "place it by hand" half: it measures the anchor and
 * returns fixed-position coordinates, flipping the panel above the trigger when
 * there is more room there. The caller owns the portal.
 *
 * Usage:
 *   const position = useAnchoredPosition(triggerRef, open, 256);
 *   position && createPortal(<div style={{ position: 'fixed', ...position }} />, document.body)
 */

import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

/** Matches the `mt-2` the panel used to carry as an absolutely-placed element. */
const GAP = 8;

/**
 * Below this a flip is better than a squeeze — a two-row list in a gap the
 * trigger happens to sit above is worse than the same list opening upward.
 */
const MIN_HEIGHT = 96;

export interface AnchoredPosition {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

/**
 * Tracks `anchor`'s viewport box while `open`, capped at `preferredHeight`.
 *
 * Returns null until the first measurement. The last position is kept when the
 * panel closes so an exit animation still has coordinates to run against.
 */
export function useAnchoredPosition(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  preferredHeight: number
): AnchoredPosition | null {
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  const measure = useCallback(() => {
    const element = anchor.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP;
    const above = rect.top - GAP;
    // Down unless it does not fit and up is roomier: a picker that flips on a
    // few pixels of difference is more surprising than one that stays put.
    const opensDown = below >= Math.min(preferredHeight, MIN_HEIGHT) || below >= above;
    const available = opensDown ? below : above;
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(preferredHeight, available));

    setPosition({
      top: opensDown ? rect.bottom + GAP : Math.max(GAP, rect.top - GAP - maxHeight),
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  }, [anchor, preferredHeight]);

  useLayoutEffect(() => {
    if (!open) return;
    // Before paint, so the panel never shows at a stale position for a frame.
    measure();

    // Capture, because the scroll that moves the trigger is a container's, and
    // a scroll event does not bubble out of it to the window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  return position;
}
