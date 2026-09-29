import { useState } from 'react';
import { useMotionPresets } from './use-motion-presets';

/**
 * Motion props for the authenticated route container: the first page appears
 * already settled, and every later move between pages fades in.
 *
 * The container is re-keyed by `pageKey`, so each navigation mounts a fresh
 * element and replays `initial`. On the very first mount that `initial` is pure
 * cost: the shell has just painted and the page would sit at opacity 0 for the
 * length of the fade, holding back the first useful screen. `initial: false`
 * tells `motion` to start at `animate`, so nothing is hidden.
 *
 * "First mount" must be remembered by whoever owns the key, not by the keyed
 * element (it is replaced on every navigation), and it is a latch: coming back
 * to the first page later is a navigation like any other and still fades.
 * The latch flips during render — React's "store information from previous
 * renders" pattern — so it costs one extra render once per layout lifetime and
 * never an extra commit.
 *
 * `animate` and `transition` come from the resolved `fade` preset, so reduced
 * motion still applies to every later navigation.
 *
 * // Usage: <motion.div key={page} {...useRouteEntrance(page)}>…</motion.div>
 */
export function useRouteEntrance(pageKey: string) {
  const { fade } = useMotionPresets();
  const [firstKey] = useState(pageKey);
  const [hasNavigated, setHasNavigated] = useState(false);
  const isFirstPage = !hasNavigated && pageKey === firstKey;

  if (!isFirstPage && !hasNavigated) setHasNavigated(true);

  return {
    initial: isFirstPage ? (false as const) : fade.initial,
    animate: fade.animate,
    transition: fade.transition,
  };
}
