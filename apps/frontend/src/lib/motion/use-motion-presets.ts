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

let cachedMatchMedia: typeof window.matchMedia | undefined;
let cachedQuery: MediaQueryList | undefined;

/** One `MediaQueryList` for the whole app rather than one per
 *  `useMotionPresets()` call site — every `SectionCard` and popover would
 *  otherwise hold its own live query for the same global preference, and
 *  `getSnapshot` runs on every render of every one of them.
 *
 *  Re-resolved only if `window.matchMedia` itself was replaced, which is what
 *  a test that substitutes it does; the cache must not outlive the environment
 *  it was built from. */
function reducedMotionQuery(): MediaQueryList {
  if (!cachedQuery || cachedMatchMedia !== window.matchMedia) {
    cachedMatchMedia = window.matchMedia;
    cachedQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  }
  return cachedQuery;
}

function subscribeReducedMotion(onChange: () => void): () => void {
  // Captured, not re-resolved on teardown: the listener must come off the same
  // object it went on even if the cache rolled over in between.
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
