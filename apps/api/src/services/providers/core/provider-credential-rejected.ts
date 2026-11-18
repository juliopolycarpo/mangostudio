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

/**
 * Vendor reasons that arrive as a 403 but say nothing about the key: a blocked
 * region, a spent quota, a billing lapse, a policy denial. Replacing a working
 * key does not fix any of them, and the vendor's own explanation is what the
 * user needs, so a 403 carrying one stays an ordinary provider error.
 * A 401 is always about the credential and never consults this list.
 */
const NON_CREDENTIAL_403_REASONS: ReadonlySet<string> = new Set([
  'unsupported_country_region_territory',
  'region_not_supported',
  'insufficient_quota',
  'quota_exceeded',
  'billing_not_active',
  'rate_limit_exceeded',
  'content_policy_violation',
]);

/**
 * Collects the machine-readable reasons a vendor SDK error carries: OpenAI puts
 * `code` and `type` on the error itself, Anthropic nests `type` under `error.error`.
 */
function readVendorReasons(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 2) return [];
  const { code, type, error: nested } = error as Record<string, unknown>;
  const own = [code, type].filter((value): value is string => typeof value === 'string');
  return [...own, ...readVendorReasons(nested, depth + 1)];
}

function readRejectionStatus(error: unknown): CredentialRejectionStatus | undefined {
  // Every vendor SDK error (OpenAI, Anthropic, Google GenAI) is an `Error` with a
  // numeric HTTP `status`; matching the field keeps this module free of the SDKs.
  if (!(error instanceof Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  if (status === 401) return status;
  if (status !== 403) return undefined;
  return readVendorReasons(error).some((reason) => NON_CREDENTIAL_403_REASONS.has(reason))
    ? undefined
    : status;
}

/**
 * Returns the shared error when `error` is a provider answering 401, or 403 for
 * a reason that is not in {@link NON_CREDENTIAL_403_REASONS}, and `undefined`
 * for anything else, so a caller keeps its own handling for the rest.
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
