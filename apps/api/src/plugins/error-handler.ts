/**
 * Centralized error handler plugin for Elysia.
 * Catches unhandled errors and returns a consistent ApiErrorResponse shape.
 * Sanitizes raw error details from logs to prevent leaking internals to clients.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';

export const errorHandler = new Elysia({ name: 'error-handler' }).onError(
  { as: 'global' },
  ({ code, error, set }): ApiErrorResponse => {
    if (code === 'VALIDATION') {
      // Elysia validation errors include the rejected request value. Do not log
      // the error object because write-only credentials may be present there.
      console.error('[error-handler][VALIDATION] Invalid request body');
      set.status = 422;
      return { error: 'Invalid request body', code: ERROR_CODES.VALIDATION };
    }

    console.error(`[error-handler][${code}]`, error);

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not found', code: ERROR_CODES.NOT_FOUND };
    }

    set.status = 500;
    return { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL };
  }
);
