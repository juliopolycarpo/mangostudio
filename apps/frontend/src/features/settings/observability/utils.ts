import type { Locale } from '@mangostudio/shared/i18n';

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTimestamp(timestamp: number): string {
  return timestampFormatter.format(timestamp);
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

/** Compact relative duration for "last used … ago": "42m", "3h 20m", "6d 4h". */
export function formatCompactDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}
