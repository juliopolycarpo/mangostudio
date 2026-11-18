/**
 * One error for "the provider rejected the connector's key".
 *
 * Each vendor SDK reports an HTTP 401 or 403 in its own `APIError`, and the
 * adapters used to fold it into `turn_error` text or let the SDK error escape.
 * Callers (the main chat turn, the subagent runner) could not tell a revoked
 * key from any other provider failure, so they could not say what to fix.
 * Every adapter now raises this error instead; it carries the shared
 * `PROVIDER_CREDENTIAL_REJECTED` code, which `getErrorCode` forwards to the
 * stream's error event unchanged.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ProviderType } from '@mangostudio/shared/types';

type CredentialRejectionStatus = 401 | 403;

export class ProviderCredentialRejectedError extends Error {
  readonly code = ERROR_CODES.PROVIDER_CREDENTIAL_REJECTED;

  constructor(
    readonly provider: ProviderType,
    readonly status: CredentialRejectionStatus,
    options?: ErrorOptions
  ) {
    // The provider's own text is left on `cause`: it can echo part of the key
    // ("Incorrect API key provided: sk-...abcd"), so it must not reach a message
    // that is persisted and sent to the client.
    super(
      `The ${provider} provider rejected the connector's API key (HTTP ${status}). It may have been revoked or expired, or lack access to this model. Check the connector in Settings.`,
      options
    );
    this.name = 'ProviderCredentialRejectedError';
  }
}

function readRejectionStatus(error: unknown): CredentialRejectionStatus | undefined {
  // Every vendor SDK error (OpenAI, Anthropic, Google GenAI) is an `Error` with a
  // numeric HTTP `status`; matching the field keeps this module free of the SDKs.
  if (!(error instanceof Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403 ? status : undefined;
}

/**
 * Returns the shared error when `error` is a provider answering 401 or 403, and
 * `undefined` for anything else, so a caller keeps its own handling for the rest.
 * // Usage: const rejection = asCredentialRejection('anthropic', err); if (rejection) throw rejection;
 */
export function asCredentialRejection(
  provider: ProviderType,
  error: unknown
): ProviderCredentialRejectedError | undefined {
  if (error instanceof ProviderCredentialRejectedError) return error;
  const status = readRejectionStatus(error);
  return status
    ? new ProviderCredentialRejectedError(provider, status, { cause: error })
    : undefined;
}

/**
 * Re-raises a 401 or 403 from `source` as {@link ProviderCredentialRejectedError}
 * and lets every other failure through untouched.
 * // Usage: yield* rejectCredentialFailures('openai', streamAgentTurnWithResponses(...));
 */
export async function* rejectCredentialFailures<T>(
  provider: ProviderType,
  source: AsyncIterable<T>
): AsyncGenerator<T> {
  try {
    yield* source;
  } catch (error) {
    throw asCredentialRejection(provider, error) ?? error;
  }
}
