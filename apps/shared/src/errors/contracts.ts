/** Generic API error response returned by all HTTP error paths. */
export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, string>;
}

/** SSE error event emitted by streaming endpoints when generation fails. */
export interface SSEErrorEvent {
  type: 'error';
  error: string;
  done: true;
}

/** Canonical error code constants shared across API and frontend. */
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  OWNERSHIP: 'OWNERSHIP',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
