import { normalizeApiErrorBody } from '@mangostudio/shared/errors';
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

/**
 * Error thrown by data-layer modules for failed API requests. `serverMessage`
 * is null when the server sent no usable error text.
 *
 * The body may arrive as the legacy `ApiErrorResponse` or as RFC 9457 problem
 * details, depending on what the request accepted and what the endpoint can
 * re-render. Nothing above this class is allowed to care: `normalizeApiErrorBody`
 * reads both, and for a negotiated body `serverMessage` is the problem's
 * `detail` — which is the same string the legacy `error` field would have
 * carried, so no rendered message changes.
 */
export class ApiError extends Error {
  readonly serverMessage: string | null;
  readonly code: string | null;
  readonly details: Readonly<Record<string, string>> | null;

  constructor(value: unknown) {
    const normalized = normalizeApiErrorBody(value);
    super(normalized.message ?? DEFAULT_API_ERROR_FALLBACK);
    this.name = 'ApiError';
    this.serverMessage = normalized.message;
    this.code = normalized.code;
    this.details = normalized.details;
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
