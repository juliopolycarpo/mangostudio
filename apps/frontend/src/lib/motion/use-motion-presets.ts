import { useEffect, useState } from 'react';
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

function useIsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION_QUERY).matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = () => setReduced(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    handleChange();
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return reduced;
}
