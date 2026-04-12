/**
 * Centralized error handler plugin for Elysia.
 * Catches unhandled errors and returns a consistent ApiErrorResponse shape.
 * Sanitizes raw error details from logs to prevent leaking internals to clients.
 */

import { Elysia } from 'elysia';
import { ERROR_CODES, type ApiErrorResponse } from '@mangostudio/shared/errors';

export const errorHandler = new Elysia({ name: 'error-handler' }).onError(
  ({ code, error, set }): ApiErrorResponse => {
    console.error(`[error-handler][${code}]`, error);

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not found', code: ERROR_CODES.NOT_FOUND };
    }

    if (code === 'VALIDATION') {
      set.status = 422;
      return { error: 'Invalid request body', code: ERROR_CODES.VALIDATION };
    }

    set.status = 500;
    return { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL };
  }
);
