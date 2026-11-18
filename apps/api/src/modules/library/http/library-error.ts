/**
 * One error mapping for every library route.
 *
 * The two failures that are not hub faults have to read the same on the
 * resource routes and the settings routes, because a user switching tabs is
 * looking at one machine either way: an environment whose runtime does not do
 * library work is a 422, and one the hub cannot reach right now is the 503
 * `environmentUnavailableResponse` gives every route — neither is logged here
 * (the connection manager logs the connect attempt itself).
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { type ElysiaStatus, status } from 'elysia';

import { environmentUnavailableResponse } from '../../../lib/environment-unavailable';
import { LibraryFeatureUnavailableError } from '../domain/library-feature-error';

/** The three answers a library route can give for a failure it did not classify itself. */
export type LibraryFailure =
  | ElysiaStatus<422, ApiErrorResponse>
  | ElysiaStatus<503, ApiErrorResponse>
  | ElysiaStatus<500, ApiErrorResponse>;

export function handleLibraryError(
  error: unknown,
  set: { headers?: Record<string, string | number | string[]> },
  logPrefix = '[library]',
  unexpectedMessage = 'Unexpected library discovery error.'
): LibraryFailure {
  if (error instanceof LibraryFeatureUnavailableError) {
    return status(422, { error: error.message, code: ERROR_CODES.VALIDATION });
  }
  const unavailable = environmentUnavailableResponse(error, set);
  if (unavailable) return unavailable;
  console.error(`${logPrefix} Unexpected error:`, error);
  return status(500, { error: unexpectedMessage, code: ERROR_CODES.INTERNAL });
}
