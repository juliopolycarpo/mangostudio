/**
 * Centralized error handler plugin for Elysia.
 * Catches unhandled errors and returns a consistent ApiErrorResponse shape.
 * Sanitizes raw error details from logs to prevent leaking internals to clients.
 */

import { Elysia } from 'elysia';

export const errorHandler = new Elysia({ name: 'error-handler' }).onError(
  ({ code, error, set }) => {
    console.error(`[error-handler][${code}]`, error);

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not found' };
    }

    if (code === 'VALIDATION') {
      set.status = 422;
      return { error: 'Invalid request body' };
    }

    set.status = 500;
    return { error: 'An internal error occurred' };
  }
);
