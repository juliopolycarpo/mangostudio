/**
 * Token counts, compacted the one way the app says them.
 *
 * A single turn shows these twice — on the composer's usage ring and again on
 * the subagent trace inside the transcript — and the two had been separate
 * copies of the same four lines, coupled only by a comment saying they must
 * agree.
 *
 * Deliberately not `Intl`'s compact notation: this is a developer-facing
 * magnitude next to a monospace figure, and `12k` is the register the rest of
 * the transcript is written in. A localized count belongs in
 * `settings/observability/utils.ts`, which uses `Intl` for exactly that reason.
 */

/**
 * // Usage: formatTokensCompact(29_400) // => '29k'
 */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
