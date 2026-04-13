/**
 * Safe JSON parsing utilities that eliminate `as unknown as T` casts
 * by coupling parsing with runtime validation in a single function.
 */

/**
 * Parses a JSON string and returns the result as a plain object,
 * or null on any parse failure. Avoids scattered try/catch + intermediate casts.
 */
export function safeJsonParse(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const result: unknown = JSON.parse(raw);
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parses a JSON string and passes the result through a guard function.
 * Returns the narrowed type on success or null on failure.
 */
export function parseJsonWith<T>(
  raw: string | null | undefined,
  guard: (parsed: Record<string, unknown>) => T | null
): T | null {
  const parsed = safeJsonParse(raw);
  if (!parsed) return null;
  return guard(parsed);
}
