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

/**
 * Every value `details.kind` can carry, which is the second half of the error
 * vocabulary: `err.code` says what class of refusal this is, `details.kind`
 * says which one.
 *
 * Here rather than beside the classes that throw them, because the class is
 * exactly what does not survive the transport. A hub reading `details.kind`
 * has no access to the runtime's `instanceof`, and a runtime written in
 * another language has no classes to offer — the string is the whole contract,
 * and both ends need to spell it the same way. The tuple is the source and the
 * union is derived, so a kind added to one is added to the other.
 */
export const RUNTIME_SERVICE_ERROR_KINDS = [
  /** The machine's owner did not grant a capability the method needs. */
  CONSENT_DENIED_KIND,
  'path_access',
  'tool_argument',
  'grep_pattern',
  'file_not_read',
  'partial_read',
  'stale_file',
  'stale_line_numbers',
  'unobserved_line_numbers',
  'shell_execution',
  /** A `terminal.*` call named a session id this runtime does not hold. */
  'terminal_not_found',
  /** A `terminal.write` reached a session whose shell has already exited. */
  'terminal_exited',
  'git_execution',
  'gh_execution',
  'workspace_browser',
  'workspace_containment',
  'workdir_validation',
  'snapshot_conflict',
  'snapshot_too_large',
  'runtime_update_refused',
  'runtime_service_unsupported',
  'runtime_service_no_session_bus',
  'runtime_service_setup_pending',
  'runtime_service_unconfigured',
  'runtime_service_binary_missing',
  'library_backup_missing',
  'mcp_connection',
  'mcp_call',
  'mcp_session_missing',
] as const;

export type RuntimeServiceErrorKind = (typeof RUNTIME_SERVICE_ERROR_KINDS)[number];

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
