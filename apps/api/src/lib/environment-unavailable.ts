/**
 * The one HTTP mapping for "the environment this request needs cannot be
 * reached right now", and the error type that selects it.
 *
 * Only an error the connection manager itself raised, while refusing or failing
 * to connect, matches. A `RemoteError` with the `UNAVAILABLE` code is not enough:
 * runtimes send that code too (terminal capacity, unconfirmed consent, a session
 * closed mid-request), and for those the request may already have run, so a 503
 * would invite a retry of work that is not safe to repeat. A connect failure
 * happens before anything is sent, which is what makes 503 + `Retry-After` honest.
 *
 * The response carries a fixed message per reason, never the error's own text:
 * that text can name hub paths, a user name or an environment variable, and the
 * hub may be served to other accounts. The full text goes to the hub log.
 */

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';

/** Why a connect was refused or failed, in the classes a client can act on. */
export const ENVIRONMENT_UNAVAILABLE_REASONS = [
  /** No runtime binary was found where the hub looked. */
  'binary-missing',
  /** The runtime or its transport failed while connecting. */
  'start-failed',
  /** A recent attempt failed; the next one is allowed after a wait. */
  'backing-off',
  /** Attempts stopped after repeated failures; a user must reconnect. */
  'stopped-retrying',
  /** The runtime is bound to another environment record. */
  'bound-elsewhere',
  /** Disabled, removed, closed or not accepting connections. */
  'unavailable',
] as const;

export type EnvironmentUnavailableReason = (typeof ENVIRONMENT_UNAVAILABLE_REASONS)[number];

/** Upper bound on a `Retry-After` the hub will send, whatever produced the wait. */
export const MAX_RETRY_AFTER_SECONDS = 3_600;

const REASON_MESSAGES: Readonly<Record<EnvironmentUnavailableReason, string>> = {
  'binary-missing': 'The runtime for this environment is not installed on the hub.',
  'start-failed': 'The environment could not be started.',
  'backing-off': 'The environment is unavailable; a new connection attempt is allowed shortly.',
  'stopped-retrying':
    'The environment stopped retrying after repeated failures; reconnect it from Environments.',
  'bound-elsewhere': "The environment's runtime is bound to another environment record.",
  unavailable: 'The environment is unavailable.',
};

/**
 * Raised by the connection manager when it refuses or fails to connect.
 * `message` keeps the full diagnostic for the hub log and for hub-side callers;
 * it is not what an HTTP client is told.
 *
 * @example
 * throw new EnvironmentUnavailableError('backing-off', 'Environment "local" is unavailable…', 4);
 */
export class EnvironmentUnavailableError extends RemoteError {
  readonly reason: EnvironmentUnavailableReason;
  /** Seconds until the manager allows another attempt, when it has scheduled one. */
  readonly retryAfterSeconds?: number;

  constructor(
    reason: EnvironmentUnavailableReason,
    message: string,
    options: {
      readonly details?: Readonly<Record<string, unknown>>;
      readonly retryAfterSeconds?: number;
    } = {}
  ) {
    super(RESERVED_ERROR_CODES.UNAVAILABLE, message, options.details);
    this.name = 'EnvironmentUnavailableError';
    this.reason = reason;
    if (options.retryAfterSeconds !== undefined && Number.isFinite(options.retryAfterSeconds)) {
      this.retryAfterSeconds = Math.min(
        MAX_RETRY_AFTER_SECONDS,
        Math.max(1, Math.ceil(options.retryAfterSeconds))
      );
    }
  }
}

export function isEnvironmentUnavailable(error: unknown): error is EnvironmentUnavailableError {
  return error instanceof EnvironmentUnavailableError;
}

/** The fixed, client-safe text for a connect failure; never the error's own message. */
export function environmentUnavailableText(error: EnvironmentUnavailableError): string {
  return REASON_MESSAGES[error.reason];
}

/**
 * Renders a connect failure as a 503 `ApiErrorResponse` with a fixed message and
 * `details.reason`, setting the status and `Retry-After` when the manager gave a
 * wait, and logging the full error once. Returns `null` for any other error so
 * the caller keeps its own classification.
 *
 * @example
 * const body = environmentUnavailableResponse(error, set);
 * if (body) return body;
 */
export function environmentUnavailableResponse(
  error: unknown,
  set: { status?: number | string; headers?: Record<string, string | number | string[]> }
): ApiErrorResponse | null {
  if (!isEnvironmentUnavailable(error)) return null;

  console.error(`[error-handler][environment-unavailable:${error.reason}]`, error);
  set.status = 503;
  if (set.headers && error.retryAfterSeconds !== undefined) {
    set.headers['Retry-After'] = String(error.retryAfterSeconds);
  }
  return {
    error: environmentUnavailableText(error),
    code: ERROR_CODES.PROVIDER_ERROR,
    details: { reason: error.reason },
  };
}
