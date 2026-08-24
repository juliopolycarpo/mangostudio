/**
 * Placeholder substitution for message templates.
 *
 * Shared by every feature that renders a `{name}` template, so a template and
 * the function that fills it in stay one contract instead of one copy per
 * feature drifting apart.
 */

/**
 * Substitutes `{key}` placeholders in a template. Unknown placeholders are left
 * untouched so a template that outruns its caller degrades to something
 * readable instead of rendering `undefined`.
 *
 * // Usage: formatMessage(t.library.matrix.selectRow, { resource: 'gh' })
 */
export function formatMessage(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/**
 * One formatter per locale, kept for the process.
 *
 * Constructing an `Intl` formatter costs far more than formatting with one, and
 * the callers are list renders: the command palette maps every chat in the
 * account through here synchronously before its overlay can paint, so an
 * account with hundreds of sessions was paying hundreds of constructions per
 * open. The options never vary, so there is nothing to key on but the locale.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeFormatters.get(locale);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  relativeFormatters.set(locale, formatter);
  return formatter;
}

/**
 * "2 days ago" in the active locale. `Intl` rather than a date library because
 * the whole need is one relative phrase, and the platform already localizes it.
 */
export function formatRelativeTime(
  timestampMs: number,
  locale: string,
  nowMs = Date.now()
): string {
  const elapsed = timestampMs - nowMs;
  const formatter = relativeFormatter(locale);
  for (const [unit, span] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= span) return formatter.format(Math.round(elapsed / span), unit);
  }
  return formatter.format(Math.round(elapsed / 1000), 'second');
}
