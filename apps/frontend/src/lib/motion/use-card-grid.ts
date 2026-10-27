import { useEffect, useState } from 'react';

import { useMotionPresets } from './use-motion-presets';
import { CARD_ENTER, CARD_REST } from './variants';

/**
 * Container props that stagger the cards present at first paint and leave later
 * arrivals settled. Motion reads `initial` when a card mounts, so changing the
 * inherited label after the first commit does not interrupt those first cards.
 *
 * The production dashboard does not emit the container's `onAnimationComplete`
 * even though its cards animate. Waiting for that callback
 * kept late cards armed with `cardRest` indefinitely. The commit itself is the
 * boundary we need: every card already mounted has captured its entrance.
 *
 * // Usage: <motion.div {...useCardGrid()} className="grid gap-4">…</motion.div>
 */
export function useCardGrid() {
  const { cardGrid } = useMotionPresets();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(true);
  }, []);

  return {
    ...cardGrid,
    initial: settled ? CARD_ENTER : CARD_REST,
  };
}
