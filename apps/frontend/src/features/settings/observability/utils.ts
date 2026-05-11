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
