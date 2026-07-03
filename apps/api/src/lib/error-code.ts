/**
 * Extracts a non-empty string `code` property from an unknown error value.
 *
 * @returns The error code when present and a non-empty string, otherwise undefined.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
