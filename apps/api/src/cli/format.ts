/**
 * Small formatting helpers for plain-text CLI output.
 */

/** Format a duration in ms as "Xh Ym Zs", omitting leading zero units. */
// Usage: formatUptime(3_661_000) // → "1h 1m 1s"
export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
