/**
 * The one HTTP mapping for "the model took too long to answer".
 *
 * A `GenerationDeadlineError` is the hub giving up on a vendor that went quiet
 * (or that ran past the handler limit), so the honest answer is 504, not a 500
 * that blames the hub. It uses the existing `PROVIDER_ERROR` code: the failing
 * party is the model provider, and a client already treats that code as a
 * retryable generation failure.
 *
 * The message is fixed. The error's own text names the provider and the
 * deadline, which is for the hub log, not for the caller.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';

import { GenerationDeadlineError } from '../services/providers/core/generation-deadline';
import { type ApiErrorStatus, apiErrorStatus } from './api-error-status';

export const GENERATION_DEADLINE_MESSAGE = 'The model took too long to respond';

/**
 * Answers 504 when `error` is a {@link GenerationDeadlineError}, otherwise `null`.
 *
 * @example
 * const timedOut = generationDeadlineResponse(error);
 * if (timedOut) return timedOut;
 */
export function generationDeadlineResponse(error: unknown): ApiErrorStatus<504> | null {
  if (!(error instanceof GenerationDeadlineError)) return null;
  return apiErrorStatus(504, {
    error: GENERATION_DEADLINE_MESSAGE,
    code: ERROR_CODES.PROVIDER_ERROR,
  });
}
