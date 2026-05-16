/**
 * Shared argument-parsing helpers for tool executors that receive raw JSON
 * objects from provider streams.
 */

export function getRequiredString(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Missing required field "${name}".`);
  return text;
}

export function getOptionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

export function getBoundedOptionalInteger(
  value: unknown,
  name: string,
  bounds: { min: number; max: number }
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Field "${name}" must be a finite number.`);
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}
