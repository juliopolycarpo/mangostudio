/**
 * Reads a `limit` query value as a page size in `1..max`.
 *
 * A value that is absent, empty, not a plain decimal integer (`abc`, `1.5`,
 * `12abc`) or not positive (`0`, `-1`) is no usable limit and yields
 * `fallback`. A positive integer above `max` yields `max`, however large:
 * `99999999999999999999` is clamped, not rejected. Negative values must never
 * pass through, because SQLite reads a negative `LIMIT` as unbounded.
 *
 * @example
 * parsePageLimit('7', { fallback: 50, max: 100 }); // 7
 * parsePageLimit('100000', { fallback: 50, max: 100 }); // 100
 * parsePageLimit('-1', { fallback: 50, max: 100 }); // 50
 */
export function parsePageLimit(
  value: string | undefined,
  bounds: { readonly fallback: number; readonly max: number }
): number {
  if (value === undefined || !/^[+-]?\d+$/.test(value)) return bounds.fallback;
  const parsed = Number(value);
  if (parsed < 1) return bounds.fallback;
  return Math.min(parsed, bounds.max);
}
