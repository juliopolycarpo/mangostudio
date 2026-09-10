import { isUnavailableCode } from '../../../services/runtime-client/remote-error-details';
/**
 * One error mapping for every library route.
 *
 * The two failures that are not hub faults have to read the same on the
 * resource routes and the settings routes, because a user switching tabs is
 * looking at one machine either way: an environment whose runtime does not do
 * library work is a 422, and one the hub cannot reach right now is the 503 the
 * environment routes already return for that code — neither is logged.
 */

import { RemoteError } from '@mangostudio/protocol';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { LibraryFeatureUnavailableError } from '../domain/library-feature-error';

export function handleLibraryError(
  error: unknown,
  set: { status?: number | string },
  logPrefix = '[library]',
  unexpectedMessage = 'Unexpected library discovery error.'
): ApiErrorResponse {
  if (error instanceof LibraryFeatureUnavailableError) {
    set.status = 422;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  if (error instanceof RemoteError && isUnavailableCode(error.code)) {
    set.status = 503;
    return { error: error.message, code: ERROR_CODES.PROVIDER_ERROR };
  }
  console.error(`${logPrefix} Unexpected error:`, error);
  set.status = 500;
  return { error: unexpectedMessage, code: ERROR_CODES.INTERNAL };
}
