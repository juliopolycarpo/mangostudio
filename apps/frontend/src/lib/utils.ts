import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extracts a human-readable message from an Eden Treaty error value.
 * API routes return `{ error: string }` on failure; this unwraps that shape.
 */
export function extractApiError(value: unknown, fallback = 'Unknown error'): string {
  if (typeof value === 'string') return value || fallback;
  if (value && typeof value === 'object' && 'error' in value) {
    const msg = (value as { error: unknown }).error;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
  return fallback;
}
