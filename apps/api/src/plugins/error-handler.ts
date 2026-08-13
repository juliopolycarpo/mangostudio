/**
 * Centralized error handler plugin for Elysia.
 * Catches unhandled errors and returns a consistent ApiErrorResponse shape.
 * Sanitizes raw error details from logs to prevent leaking internals to clients.
 *
 * These handlers are also what keeps Elysia's own RFC 9457 `problem+json`
 * default off the wire: every arm answers with `ApiErrorResponse` as
 * `application/json`, which is the contract every MangoStudio client is written
 * against. Adopting problem details is a deliberate, separate change.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, NotFound, ValidationError } from 'elysia';

/**
 * True when a body rejection came from the file-type detector rather than from
 * JSON Schema.
 *
 * Elysia 2 dropped the dedicated `INVALID_FILE_TYPE` code, so a mistyped upload
 * now arrives as an ordinary `ValidationError`. Detector findings are the ones
 * carrying no `keyword`: they are produced by sniffing the uploaded bytes, not
 * by a schema keyword failing. Without this the user's mistyped file would read
 * as a malformed request body.
 */
function isFileTypeRejection(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((entry) => typeof entry === 'object' && entry !== null && !('keyword' in entry))
  );
}

export const errorHandler = new Elysia({ name: 'error-handler' })
  .error('global', ValidationError, ({ error, set }): ApiErrorResponse => {
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
    // A file whose bytes are not the type a route accepts is a bad request, not
    // a server fault, and not the same mistake as a malformed body.
    if (isFileTypeRejection(error.errors)) {
      return { error: 'Unsupported file type', code: ERROR_CODES.VALIDATION };
    }
    return { error: 'Invalid request body', code: ERROR_CODES.VALIDATION };
  })
  .error('global', NotFound, ({ set }): ApiErrorResponse => {
    set.status = 404;
    return { error: 'Not found', code: ERROR_CODES.NOT_FOUND };
  })
  .error('global', ({ error, set }): ApiErrorResponse => {
    // The raw error is deliberately logged server-side — it is the only record
    // of what actually failed — while the client is told nothing about it.
    console.error(`[error-handler][${error instanceof Error ? error.name : 'unknown'}]`, error);
    set.status = 500;
    return { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL };
  });
