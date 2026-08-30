import { useReducedMotion } from 'motion/react';
import { type MotionPresets, motionPresets } from './variants';

/**
 * The shared motion presets, already resolved against the user's
 * `prefers-reduced-motion` setting.
 *
 * `useReducedMotion()` subscribes to the media query, so a component re-renders
 * with the still presets the moment the OS setting flips — no reload needed.
 * The returned object is one of two module-level constants, so it is referen-
 * tially stable and safe to spread into `motion` props every render.
 *
 * // Usage: const { overlay } = useMotionPresets();
 */
export function useMotionPresets(): MotionPresets {
  // `=== true` rather than `??`: the real hook returns `boolean | null` (null
  // until it has read the media query) and null means "not reduced".
  return motionPresets(useReducedMotion() === true);
}
