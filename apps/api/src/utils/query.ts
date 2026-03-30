/**
 * Parses a query-string value as a safe integer.
 * Returns `defaultValue` when the input is absent or not a valid integer.
 */
export function parseQueryInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
