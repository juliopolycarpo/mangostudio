/**
 * Returns a masked representation of a secret for display purposes.
 *
 * - Null / undefined / empty → undefined
 * - 4 characters or fewer → '****'
 * - Longer strings → '****...<last 4 chars>'
 */
export function maskSecret(secret: string | null | undefined): string | undefined {
  if (!secret) return undefined;
  if (secret.length <= 4) return '****';
  return `****...${secret.slice(-4)}`;
}
