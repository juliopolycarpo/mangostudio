import { useSyncExternalStore } from 'react';
import { type MotionPresets, motionPresets } from './variants';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The shared motion presets, already resolved against the user's
 * `prefers-reduced-motion` setting.
 *
 * This subscribes to the media query itself rather than trusting
 * `motion/react`'s `useReducedMotion()`, which in the installed version reads
 * the preference once via `useState` and never re-renders on change. A
 * component re-renders with the still presets the moment the OS setting
 * flips — no reload needed. The returned object is one of two module-level
 * constants, so it is referentially stable and safe to spread into `motion`
 * props every render.
 *
 * // Usage: const { overlay } = useMotionPresets();
 */
export function useMotionPresets(): MotionPresets {
  return motionPresets(useIsReducedMotion());
}

/** One `matchMedia` subscription for the whole app rather than one per
 *  `useMotionPresets()` call site — every `SectionCard` and popover would
 *  otherwise mount its own listener for the same global preference. */
const reducedMotionQuery = () => window.matchMedia(REDUCED_MOTION_QUERY);

function subscribeReducedMotion(onChange: () => void): () => void {
  const mediaQuery = reducedMotionQuery();
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

function getReducedMotionSnapshot(): boolean {
  return reducedMotionQuery().matches;
}

function useIsReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot);
}
