/**
 * One error mapping for every library route.
 *
 * The two failures that are not hub faults have to read the same on the
 * resource routes and the settings routes, because a user switching tabs is
 * looking at one machine either way: an environment whose runtime does not do
 * library work is a 422, and one the hub cannot reach right now is the 503 the
 * environment routes already return for that code — neither is logged.
 */

import { RuntimeRemoteError } from '@mangostudio/runtime';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { LibraryFeatureUnavailableError } from '../application/environment-library-service';

export function handleLibraryError(
  error: unknown,
  set: { status?: number | string },
  logPrefix = '[library]'
): ApiErrorResponse {
  if (error instanceof LibraryFeatureUnavailableError) {
    set.status = 422;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  if (error instanceof RuntimeRemoteError && error.code === 'RUNTIME_UNAVAILABLE') {
    set.status = 503;
    return { error: error.message, code: ERROR_CODES.PROVIDER_ERROR };
  }
  console.error(`${logPrefix} Unexpected error:`, error);
  set.status = 500;
  return { error: 'Unexpected library discovery error.', code: ERROR_CODES.INTERNAL };
}
