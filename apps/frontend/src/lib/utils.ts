import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { en } from '@mangostudio/shared/i18n';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const defaultApiErrorFallback = en.errors.unknown;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extracts a human-readable message from an Eden Treaty error value.
 * API routes return `ApiErrorResponse` on failure; this unwraps the error field.
 */
export function extractApiError(value: unknown, fallback = defaultApiErrorFallback): string {
  if (typeof value === 'string') return value || fallback;
  if (value && typeof value === 'object') {
    const v = value as Partial<ApiErrorResponse>;
    if (typeof v.error === 'string' && v.error) return v.error;
  }
  return fallback;
}
