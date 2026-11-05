/**
 * Parse canonical GitHub UTC metadata without calendar rollover or timezone aliases.
 * Accept seconds or exactly three millisecond digits and preserve a field-specific error.
 * @example parseGitHubTimestamp('2026-11-04T10:05:00Z', 'artifact created_at');
 */
export function parseGitHubTimestamp(value: unknown, label: string): number {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    const parsed = Date.parse(value);
    const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
    if (Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical) return parsed;
  }
  throw new Error(`${label}: expected UTC ISO timestamp; received ${JSON.stringify(value)}`);
}
