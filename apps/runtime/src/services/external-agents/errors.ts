/**
 * Vendor failures, kept structured across the boundary.
 *
 * Flattening a vendor error to a string is what makes "it failed" the only
 * thing anyone can say afterwards — including the code deciding whether to
 * retry. The JSON-RPC code, the id of the request that failed and the
 * retryability all survive into `ExternalAgentError`, where the neutral contract
 * already has fields waiting for them.
 *
 * Shared between adapters because the mapping is a property of JSON-RPC, not of
 * a vendor: both Codex `app-server` and Cursor ACP return the same error frame,
 * and two copies of `isRetryable` would eventually disagree about which codes
 * are worth a second attempt.
 */

import type { ExternalAgentError } from '@mangostudio/shared/external-agents';
import { JsonRpcCallError } from './jsonrpc';

/**
 * JSON-RPC reserved codes are protocol-level and mean this client sent
 * something wrong; retrying the identical call would fail identically. A
 * vendor's own application codes sit outside that range, where a retry can
 * legitimately succeed.
 */
function isRetryable(code: number): boolean {
  return code > -32000 || code < -32768;
}

export function toExternalAgentError(error: unknown, fallbackCode: string): ExternalAgentError {
  if (error instanceof JsonRpcCallError) {
    return {
      code: fallbackCode,
      message: error.message,
      requestId: error.requestId,
      retryable: isRetryable(error.code),
      vendorCode: String(error.code),
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * A typed failure the supervisor surfaces without a vendor frame behind it.
 *
 * `code` is the adapter's own vocabulary — `codex-session-missing`,
 * `cursor-handshake-failed` — and is prefixed by vendor so a log line names
 * which adapter refused without a second field.
 */
export class ExternalAgentAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExternalAgentAdapterError';
    this.code = code;
  }
}
