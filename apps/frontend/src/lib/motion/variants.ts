import { DURATION_BASE, DURATION_QUICK, EASE_STANDARD } from './tokens';

/**
 * The app's motion vocabulary: one preset per *kind* of movement, rather than a
 * transition literal per call site.
 *
 * Every preset is built twice — once moving, once still — and
 * `motionPresets(reduced)` picks between them. The still set is not a nicety:
 * the global `prefers-reduced-motion` rule in `index.css` only reaches CSS
 * transitions and keyframes, so a JS-driven spring keeps moving for a user who
 * asked the OS for no movement. Honouring that is what this file is for.
 *
 * Presets are plain object literals on purpose. Annotating them with a wide
 * `Record<string, number | string>` would stop them being assignable to
 * `motion`'s `Target` (which types `opacity` as a number, not a string), and
 * importing `motion`'s own types here would resolve to the test stub under
 * `tsconfig.test.json`. Inference gives us both ends for free.
 */

/** The still variants keep every key the moving ones have, at a no-op value, so
 *  both branches infer one shape and a call site can swap between them. */
const NO_OFFSET = 0;
const NO_SCALE = 1;

/** Cards enter this far apart. Short enough that nine of them read as one
 *  gesture rather than a sequence the user has to wait out. */
const CARD_STAGGER_STEP = 0.04;

/** Variant labels for the hub card grids.
 *
 * Deliberately not `hidden`/`visible`: `motion` propagates variant labels down
 * through React context, so a card sharing the generic names would start
 * animating whenever *any* ancestor happened to drive a variant of the same
 * name. These names are only ever driven by the grids in this app.
 */
export const CARD_REST = 'cardRest';
export const CARD_ENTER = 'cardEnter';

/**
 * Per-child delay for a staggered container, as `delayChildren` accepts it.
 *
 * Hand-rolled rather than `motion`'s `stagger()` helper for two reasons: it
 * keeps this module free of a `motion/react` import (which the test stub would
 * have to grow an export for), and `transition.staggerChildren` — the other way
 * to spell this — is deprecated as of motion 12.22.
 *
 * // Usage: transition: { delayChildren: staggerBy(0.04) }
 */
export function staggerBy(step: number): (index: number) => number {
  return (index) => index * step;
}

function buildPresets(reduced: boolean) {
  const duration = reduced ? 0 : DURATION_BASE;
  const quick = reduced ? 0 : DURATION_QUICK;
  const ease = EASE_STANDARD;

  /** Dropdown panels. `offsetY` is signed by the direction the panel opens:
   *  negative drops from its trigger, positive rises into place above it. */
  const popover = (offsetY: number) => {
    const y = reduced ? NO_OFFSET : offsetY;
    const scale = reduced ? NO_SCALE : 0.96;
    return {
      initial: { opacity: 0, y, scale },
      animate: { opacity: 1, y: NO_OFFSET, scale: NO_SCALE },
      exit: { opacity: 0, y, scale },
      transition: { duration: quick, ease },
    };
  };

  return {
    /** Full-surface scrim behind a dialog, lightbox or the palette. */
    overlay: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: quick, ease },
    },

    /** The panel that sits on top of an `overlay`. */
    dialogPanel: {
      initial: { opacity: 0, y: reduced ? NO_OFFSET : -8, scale: reduced ? NO_SCALE : 0.97 },
      animate: { opacity: 1, y: NO_OFFSET, scale: NO_SCALE },
      exit: { opacity: 0, y: reduced ? NO_OFFSET : -4, scale: reduced ? NO_SCALE : 0.98 },
      transition: { duration, ease },
    },

    /** A panel anchored under its trigger. */
    popoverBelow: popover(-6),

    /** A panel anchored above its trigger — the composer's selectors open
     *  upward, so their enter offset is positive: they rise into place. */
    popoverAbove: popover(8),

    /** Disclosure bodies that push their neighbours down as they open.
     *  Height is animated rather than transformed on purpose: these live inside
     *  virtualized chat rows, and the virtualizer sizes a row from its measured
     *  height. A `scaleY` would look the same and leave every row below it
     *  overlapping. */
    collapse: {
      initial: { opacity: 0, height: 0 },
      animate: { opacity: 1, height: 'auto' },
      exit: { opacity: 0, height: 0 },
      transition: { duration, ease },
    },

    /** Something arriving in place, without a direction to travel from. */
    fade: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration, ease },
    },

    /** Transient surfaces anchored to an edge: toasts, the scroll-to-latest
     *  button. They rise the few pixels they were offset by. */
    fadeRise: {
      initial: { opacity: 0, y: reduced ? NO_OFFSET : 8 },
      animate: { opacity: 1, y: NO_OFFSET },
      exit: { opacity: 0, y: reduced ? NO_OFFSET : 8 },
      transition: { duration, ease },
    },

    /** Container variants for a card grid. Drives `cardItem` on every
     *  descendant card through context — see `CARD_REST`. */
    cardGrid: {
      [CARD_REST]: {},
      [CARD_ENTER]: {
        transition: { delayChildren: reduced ? 0 : staggerBy(CARD_STAGGER_STEP) },
      },
    },

    /** Item variants for one card inside a `cardGrid`. */
    cardItem: {
      [CARD_REST]: { opacity: 0, y: reduced ? NO_OFFSET : 6 },
      [CARD_ENTER]: { opacity: 1, y: NO_OFFSET, transition: { duration, ease } },
    },
  };
}

export type MotionPresets = ReturnType<typeof buildPresets>;

const MOVING = buildPresets(false);
const STILL = buildPresets(true);

/**
 * The motion vocabulary, in the register the user asked for.
 *
 * Prefer the `useMotionPresets()` hook in components; call this directly only
 * where there is no React context to read the preference from.
 *
 * // Usage: const { overlay } = motionPresets(false);
 */
export function motionPresets(reduced: boolean): MotionPresets {
  return reduced ? STILL : MOVING;
}
