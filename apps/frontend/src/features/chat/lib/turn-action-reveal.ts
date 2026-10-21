/**
 * How the actions on a turn's separator (copy, revert, the timestamp) stay out
 * of the way until they are wanted.
 *
 * Hidden at rest and shown while the turn is hovered (`group` is the turn's
 * block) or the control itself has keyboard focus. A touch screen has no hover:
 * Tailwind wraps `hover:` and `group-hover:` in `@media (hover: hover)`, so
 * without the last term these never showed on a phone and the turn's actions
 * were unreachable there. `pointer-coarse` shows them at rest instead.
 *
 * Kept as one string so the three controls cannot disagree about when they
 * appear. Spelled out in full because Tailwind finds classes by scanning for
 * them.
 */
export const TURN_ACTION_REVEAL =
  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100';
