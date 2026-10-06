/**
 * Centralized error handler plugin for Elysia.
 * Catches unhandled errors and returns a consistent ApiErrorResponse shape.
 * Sanitizes raw error details from logs to prevent leaking internals to clients.
 *
 * These handlers are also what keeps Elysia's own RFC 9457 `problem+json`
 * default off the wire: every arm classifies into an `ApiErrorResponse`, which
 * is the contract every MangoStudio client is written against, and
 * `negotiateErrorRepresentation` re-renders it as problem details only for the
 * callers that explicitly ask.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, type ElysiaStatus, NotFound, status, ValidationError } from 'elysia';
import { negotiateErrorRepresentation } from './error-negotiation';

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
  // Seated before the `.error` arms so it also covers what they return.
  //
  // `global` reaches further than `/api/**`: the same scope that lets this
  // plugin's `NotFound` arm answer a non-API miss also lets the negotiator
  // re-render it. That is the right pairing — those responses already *are*
  // `ApiErrorResponse` — and it is why the body gate matters more than the
  // route scope. Anything that is not exactly an `ApiErrorResponse` at a 4xx or
  // 5xx passes through untouched, whoever served it.
  .mapResponse('global', ({ request, set, responseValue }) =>
    negotiateErrorRepresentation(request, set, responseValue)
  )
  .error(
    'global',
    ValidationError,
    ({ error }): ElysiaStatus<422, ApiErrorResponse> | ElysiaStatus<500, ApiErrorResponse> => {
      // `error.value` carries the rejected payload, so never log the error
      // object itself — write-only credentials may be present there. `type`
      // names the failing side only, which is safe and enough to triage.
      console.error(`[error-handler][VALIDATION] rejected ${error.type}`);

      // A response that fails our own schema is a server bug: reporting it as
      // 422 would tell the caller to fix a request that was never at fault.
      if (error.type === 'response') {
        return status(500, { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL });
      }

      // A file whose bytes are not the type a route accepts is a bad request, not
      // a server fault, and not the same mistake as a malformed body.
      if (isFileTypeRejection(error.errors)) {
        return status(422, { error: 'Unsupported file type', code: ERROR_CODES.VALIDATION });
      }
      return status(422, { error: 'Invalid request body', code: ERROR_CODES.VALIDATION });
    }
  )
  .error(
    'global',
    NotFound,
    (): ElysiaStatus<404, ApiErrorResponse> =>
      status(404, { error: 'Not found', code: ERROR_CODES.NOT_FOUND })
  )
  .error('global', ({ error }): ElysiaStatus<500, ApiErrorResponse> => {
    // The raw error is deliberately logged server-side — it is the only record
    // of what actually failed — while the client is told nothing about it.
    console.error(`[error-handler][${error instanceof Error ? error.name : 'unknown'}]`, error);
    return status(500, { error: 'An internal error occurred', code: ERROR_CODES.INTERNAL });
  });
