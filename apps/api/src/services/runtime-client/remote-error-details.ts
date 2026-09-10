/**
 * Reading a failed runtime call: the abort case, and the `details` bag.
 *
 * `details` crosses the protocol as an open record, so everything in it arrives
 * as `unknown` no matter what the runtime meant to put there. Every CLI facade
 * that maps a remote failure back onto a local error class needs the same
 * narrowings, and a facade that skips one turns a malformed frame into a
 * `TypeError` thrown from an error handler — the worst place to throw.
 */

import { RESERVED_ERROR_CODES, type RemoteError } from '@mangostudio/protocol';

/**
 * The `details[key]` string, or undefined when the peer sent something else.
 *
 * @example
 * detailString(error, 'stderr') ?? error.message
 */
export function detailString(error: RemoteError, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** True only for an explicit `true`; a missing or malformed flag is false. */
export function detailBoolean(error: RemoteError, key: string): boolean {
  return error.details?.[key] === true;
}

/**
 * The `details.exitCode` number, or null.
 *
 * Null is the honest answer for a process that never started, which is exactly
 * the case that also tends to send a malformed field.
 */
export function detailExitCode(error: RemoteError): number | null {
  const value = error.details?.exitCode;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * The `details[key]` array of strings, or undefined unless every entry is one.
 *
 * All-or-nothing: a half-typed argv reported back to a user is more misleading
 * than the argv the caller already had.
 *
 * @example
 * detailStringArray(error, 'args') ?? args
 */
export function detailStringArray(error: RemoteError, key: string): string[] | undefined {
  const value = error.details?.[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value;
}

/**
 * Whether a rejection is the caller hanging up rather than the runtime failing.
 *
 * Checked before `details`, because an aborted request never reached the peer
 * and so carries no details to read.
 *
 * @example
 * if (isAbortError(error)) return new GhCliError(args, null, 'aborted', true);
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Whether a refusal means "this runtime is not reachable".
 *
 * Two literals, not one, while the transports move across: the ones already on
 * the SDK answer `UNAVAILABLE`, the ones still on the hand-written framing
 * answer `RUNTIME_UNAVAILABLE`. A hub that recognised only one would report a
 * dead runtime as an ordinary tool failure on half its environments.
 *
 * @example
 * if (error instanceof RemoteError && isUnavailableCode(error.code)) markUnavailable();
 */
export function isUnavailableCode(code: string): boolean {
  return code === RESERVED_ERROR_CODES.UNAVAILABLE || code === 'RUNTIME_UNAVAILABLE';
}

/**
 * Whether a refusal means "this machine's owner did not grant it". Both
 * vocabularies, for the reason {@link isUnavailableCode} carries two.
 *
 * @example
 * if (isDeniedCode(error.code)) return new RuntimeConsentDeniedError(error.message);
 */
export function isDeniedCode(code: string): boolean {
  return code === RESERVED_ERROR_CODES.DENIED || code === 'RUNTIME_DENIED';
}
