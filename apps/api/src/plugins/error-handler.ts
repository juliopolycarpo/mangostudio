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
      // `error.value` carries the rejected payload, so never log the error
      // object itself — write-only credentials may be present there. `type`
      // names the failing side only, which is safe and enough to triage.
      console.error(`[error-handler][VALIDATION] rejected ${error.type}`);
      // A response that fails our own schema is a server bug: reporting it as
      // 422 would tell the caller to fix a request that was never at fault.
      if (error.type === 'response') {
        set.status = 500;
        return { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL };
      }
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
