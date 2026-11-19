import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { TurnInterruptionReasonCode } from '@mangostudio/shared/turn-recovery';

import {
  environmentUnavailableText,
  isEnvironmentUnavailable,
} from '../../../lib/environment-unavailable';
import { getErrorCode } from '../../../lib/error-code';
import { GENERATION_DEADLINE_MESSAGE } from '../../../lib/generation-deadline-response';
import { GenerationDeadlineError } from '../../../services/providers/core/generation-deadline';

export interface TurnFailureDescription {
  /** The error's own text, for the hub log. */
  readonly rawMessage: string;
  /** The text persisted in the transcript and sent to the client. */
  readonly message: string;
  readonly code?: string;
}

/**
 * What a failed turn tells the user, shared by every route that records one.
 * An unreachable environment gets the fixed text the HTTP routes use; the
 * diagnostic (paths, usernames) stays in the hub log.
 */
export function describeTurnFailure(error: unknown): TurnFailureDescription {
  const rawMessage = error instanceof Error ? error.message : 'Stream generation failed';
  const unavailable = isEnvironmentUnavailable(error) ? error : undefined;
  // A deadline's own text names the provider and the limit; the transcript gets
  // the fixed message the 504 answer carries.
  const message = unavailable
    ? environmentUnavailableText(unavailable)
    : error instanceof GenerationDeadlineError
      ? GENERATION_DEADLINE_MESSAGE
      : rawMessage;
  const code = unavailable ? ERROR_CODES.ENVIRONMENT_UNAVAILABLE : getErrorCode(error);
  return { rawMessage, message, ...(code ? { code } : {}) };
}

/** Why an aborted turn stopped, from the reason its signal was aborted with. */
export function getAbortInterruptionReason(
  signal: AbortSignal
): Extract<TurnInterruptionReasonCode, 'client_disconnect' | 'user_cancelled' | 'unknown'> {
  const reason = signal.reason;
  if (reason === 'client_disconnect' || reason === 'user_cancelled') return reason;
  return 'unknown';
}
