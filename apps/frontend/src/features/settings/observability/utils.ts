import type { Locale } from '@mangostudio/shared/i18n';

const timestampFormatters = new Map<Locale, Intl.DateTimeFormat>();

/**
 * Formats a Settings timestamp in the selected app language and viewer timezone.
 * Invalid timestamps retain Intl's RangeError.
 *
 * @example
 * formatTimestamp(entry.timestamp, locale);
 */
export function formatTimestamp(timestamp: number, locale: Locale): string {
  const cached = timestampFormatters.get(locale);
  const formatter =
    cached ?? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  if (!cached) timestampFormatters.set(locale, formatter);
  return formatter.format(timestamp);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Locale-aware compact integer for token totals: "1,234", "12.3k"-style grouping. */
export function formatTokenCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    Math.round(value)
  );
}
