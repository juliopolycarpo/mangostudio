/**
 * The error vocabulary the hub and the runtime share, on top of the ten codes
 * the protocol reserves.
 *
 * A leaf on purpose: `environments/schemas.ts` needs the code union for the
 * connection status it publishes, and `runtime-contract/methods.ts` needs the
 * environment types, so anything this file imported from the rest of shared
 * would close that loop and `madge` would report it.
 *
 * The wire keeps `err.code` open — an unknown code is a refusal from a newer
 * peer, not a protocol violation — so consumers narrow with
 * {@link narrowRuntimeErrorCode} rather than validate.
 */

import { RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import Type from 'typebox';

/** Carried in `details.kind` so a hub can tell a consent refusal from a fault. */
export const CONSENT_DENIED_KIND = 'consent_denied';

/** Application code: a live binary transfer was unsafe, malformed, busy, or out of sequence. */
export const RUNTIME_UPDATE_REFUSED = 'RUNTIME_UPDATE_REFUSED';

const RUNTIME_ERROR_CODES = [...Object.values(RESERVED_ERROR_CODES), RUNTIME_UPDATE_REFUSED];

/** Every `err.code` this build recognises: the reserved ten plus the application's own. */
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export const RuntimeErrorCodeSchema = Type.Unsafe<RuntimeErrorCode>(
  Type.Union(RUNTIME_ERROR_CODES.map((code) => Type.Literal(code)))
);

const KNOWN_RUNTIME_ERROR_CODES = new Set<string>(RUNTIME_ERROR_CODES);

/**
 * Map a wire error code onto the known union. A code this build has never
 * heard of is a policy refusal from the future (or a typo); treating either as
 * a protocol violation would drop the connection instead of surfacing a state.
 *
 * @example
 * narrowRuntimeErrorCode('DENIED'); // 'DENIED'
 * narrowRuntimeErrorCode('WHAT_IS_THIS'); // 'INTERNAL'
 */
export function narrowRuntimeErrorCode(code: string): RuntimeErrorCode {
  return KNOWN_RUNTIME_ERROR_CODES.has(code) ? (code as RuntimeErrorCode) : 'INTERNAL';
}
