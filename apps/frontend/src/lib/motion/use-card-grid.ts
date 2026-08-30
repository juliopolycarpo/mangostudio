import { useCallback, useState } from 'react';
import { useMotionPresets } from './use-motion-presets';
import { CARD_ENTER, CARD_REST } from './variants';

/**
 * Container props for a hub card grid, with the entrance armed only until it
 * has been played.
 *
 * `motion` copies the container's `initial` onto any variant child that does
 * not set its own, and it keeps doing so for the life of the wrapper. Hub cards
 * render `null` until they have something to show — the GitHub inbox, the
 * library divergence scan, the uncommitted-work summaries all arrive after
 * first paint — so a fixed `initial: cardRest` would mount each of them hidden
 * and fade it in against a grid that settled seconds ago.
 *
 * Flipping to `CARD_ENTER` once the grid's own entrance completes leaves the
 * first-paint stagger intact and hands every later arrival the settled state.
 * Mounted cards are unaffected: `initial` is read at mount and never again.
 *
 * // Usage: <motion.div {...useCardGrid()} className="grid gap-4">…</motion.div>
 */
export function useCardGrid() {
  const { cardGrid } = useMotionPresets();
  const [settled, setSettled] = useState(false);

  // `definition` is typed `unknown` rather than imported from `motion/react`:
  // under `tsconfig.test.json` that specifier resolves to the test stub, which
  // exports no types. Comparing against the label needs nothing wider.
  const onAnimationComplete = useCallback((definition: unknown) => {
    if (definition === CARD_ENTER) setSettled(true);
  }, []);

  return {
    ...cardGrid,
    initial: settled ? CARD_ENTER : CARD_REST,
    onAnimationComplete,
  };
}
