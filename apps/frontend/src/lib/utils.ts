import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Neutral, non-localized message used when a failed request carries no server
 * text. Render layers swap absent server messages for a localized label via
 * `resolveApiErrorMessage`. Duplicates `en.errors.unknown` on purpose (importing
 * `en` here would violate the frontend i18n import guard); a unit test pins
 * the two strings together.
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
 * Error thrown by data-layer modules for failed API requests. `serverMessage`
 * is null when the server sent no usable error text.
 */
export class ApiError extends Error {
  readonly serverMessage: string | null;
  readonly code: string | null;
  readonly details: Readonly<Record<string, string>> | null;

  constructor(value: unknown) {
    const serverMessage = extractServerMessage(value);
    super(serverMessage ?? DEFAULT_API_ERROR_FALLBACK);
    this.name = 'ApiError';
    this.serverMessage = serverMessage;
    const response =
      value && typeof value === 'object' ? (value as Partial<ApiErrorResponse>) : null;
    this.code = typeof response?.code === 'string' ? response.code : null;
    this.details = response?.details ?? null;
  }
}

/**
 * Throws an `ApiError` from an Eden error channel that TypeScript sees as `{}`.
 *
 * Eden Treaty loses the error type for hyphenated route segments (`/api-keys`,
 * `/tool-identities`) even though the runtime payload carries `.value` like any
 * other. Narrowing here keeps those modules reading like the ones where the
 * type survives, instead of each restating the same cast.
 */
export function throwApiError(error: unknown): never {
  const value =
    error && typeof error === 'object' && 'value' in error
      ? (error as { value: unknown }).value
      : error;
  throw new ApiError(value);
}

/**
 * Picks the user-facing message for a failed request: the API's own error text
 * when the server sent one, otherwise the caller's localized label.
 */
export function resolveApiErrorMessage(error: unknown, localizedFallback: string): string {
  if (error instanceof ApiError) return error.serverMessage ?? localizedFallback;
  return localizedFallback;
}
