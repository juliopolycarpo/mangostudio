/**
 * Serializers for SQLite column types that require encoding/decoding.
 * Keeps the conversion between storage types and domain types in one place.
 */

/** Converts a boolean to the SQLite integer representation (0 | 1). */
export function boolToInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Parses the JSON-encoded styleParams column into a string array. */
export function parseStyleParams(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return undefined;
  }
}

/** Serializes a styleParams array to its JSON column representation. */
export function serializeStyleParams(params: string[] | undefined | null): string | null {
  if (!params) return null;
  return JSON.stringify(params);
}
