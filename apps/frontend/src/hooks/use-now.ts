import { useEffect, useState } from 'react';

/**
 * A clock that re-renders its caller on a fixed interval.
 *
 * For labels formatted against "now". A relative timestamp is computed during a
 * render, so on a surface that does not poll it keeps reporting what was true
 * when that render happened — "updated now" stays on screen minutes later.
 *
 * Pass `null` to stop the timer while the caller is not showing such a label,
 * so an idle panel is not re-rendering on a timer for nothing. Re-enabling it
 * reads the clock immediately rather than waiting out the first interval.
 *
 * @example
 * const now = useNow(30_000);
 * formatRelativeTime(cachedAt, locale, now);
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
