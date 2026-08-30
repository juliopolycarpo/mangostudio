/**
 * Motion tokens, mirrored from the `--duration-*` and `--ease-*` custom
 * properties in `src/index.css`.
 *
 * The CSS is the source of truth; this file exists because `motion` takes
 * durations as **seconds** and easings as coefficient tuples, neither of which
 * a CSS `var()` can be handed to. `tests/unit/lib/motion/tokens.test.ts` parses
 * `index.css` and fails if the two ever disagree — including the off-by-1000
 * that writing `200` instead of `0.2` here would otherwise ship silently.
 *
 * // Usage: transition={{ duration: DURATION_BASE, ease: EASE_STANDARD }}
 */

/** ~120ms. Hover and press feedback — the user is still holding the control. */
export const DURATION_QUICK = 0.12;

/** ~200ms. Enter/exit of content that was already on its way. */
export const DURATION_BASE = 0.2;

/** ~320ms. Panels and overlays that take over the surface. */
export const DURATION_SLOW = 0.32;

/**
 * Cubic-bezier coefficients, typed as a mutable tuple because `motion` types
 * its `ease` option as `number[]` and a `readonly` tuple is not assignable.
 */
export type EaseTuple = [number, number, number, number];

/** Decelerate-to-rest. The default for anything that moves on screen. */
export const EASE_STANDARD: EaseTuple = [0.2, 0, 0, 1];

/** A firmer settle, for the few things that should feel deliberate. */
export const EASE_EMPHASIZED: EaseTuple = [0.05, 0.7, 0.1, 1];
