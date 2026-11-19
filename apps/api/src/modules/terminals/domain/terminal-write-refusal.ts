/**
 * How the hub reads a failed `terminal.write`: what to tell the browser, and
 * whether asking the runtime once more is safe.
 */

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';
import type { TerminalWriteError } from '@mangostudio/shared/terminal';

import { noReplyOf } from '../../../services/runtime-client/request-not-sent';

/**
 * Whether the runtime itself answered `UNAVAILABLE` (or the request provably
 * never left this hub), so the bytes did not reach the shell and sending them
 * again cannot type them twice. An `UNAVAILABLE` from a session that closed
 * after the frame was written carries a no-reply cause and is not safe.
 *
 * @example
 * if (isSafeToRetryWrite(error)) await client.terminal.write(params);
 */
export function isSafeToRetryWrite(error: unknown): boolean {
  return (
    error instanceof RemoteError &&
    error.code === RESERVED_ERROR_CODES.UNAVAILABLE &&
    noReplyOf(error) === undefined
  );
}

/**
 * The frame that tells the browser its input was refused.
 *
 * @example
 * classifyWriteRefusal(new RuntimeConsentDeniedError('no', {})); // { code: 'consent_revoked', retryable: false }
 */
export function classifyWriteRefusal(error: unknown): TerminalWriteError {
  if (error instanceof RuntimeConsentDeniedError) {
    return { code: 'consent_revoked', retryable: false };
  }
  if (isSafeToRetryWrite(error)) return { code: 'consent_unconfirmed', retryable: true };
  return { code: 'write_failed', retryable: false };
}
