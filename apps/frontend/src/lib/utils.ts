import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Neutral, non-localized message used when a failed request carries no server
 * text. Render layers swap absent server messages for a localized label via
 * `resolveApiErrorMessage`.
 */
export const DEFAULT_API_ERROR_FALLBACK = 'An unknown error occurred';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function extractServerMessage(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const v = value as Partial<ApiErrorResponse>;
    if (typeof v.error === 'string' && v.error) return v.error;
  }
  return null;
}

/**
 * Extracts a human-readable message from an Eden Treaty error value.
 * API routes return `ApiErrorResponse` on failure; this unwraps the error field.
 */
export function extractApiError(value: unknown, fallback = DEFAULT_API_ERROR_FALLBACK): string {
  return extractServerMessage(value) ?? fallback;
}

/**
 * Error thrown by data-layer modules for failed API requests. `serverMessage`
 * is null when the server sent no usable error text.
 */
export class ApiError extends Error {
  readonly serverMessage: string | null;

  constructor(value: unknown) {
    const serverMessage = extractServerMessage(value);
    super(serverMessage ?? DEFAULT_API_ERROR_FALLBACK);
    this.name = 'ApiError';
    this.serverMessage = serverMessage;
  }
}

/**
 * Picks the user-facing message for a failed request: the API's own error text
 * when the server sent one, otherwise the caller's localized label.
 */
export function resolveApiErrorMessage(error: unknown, localizedFallback: string): string {
  if (error instanceof ApiError) return error.serverMessage ?? localizedFallback;
  return localizedFallback;
}
