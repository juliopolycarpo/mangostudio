import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { CONSENT_DENIED_KIND, RUNTIME_UPDATE_REFUSED } from '@mangostudio/shared/runtime-contract';

export type RuntimeServiceErrorKind =
  /** The machine's owner did not grant a capability the method needs. */
  | 'consent_denied'
  | 'path_access'
  | 'tool_argument'
  | 'grep_pattern'
  | 'file_not_read'
  | 'partial_read'
  | 'stale_file'
  | 'stale_line_numbers'
  | 'unobserved_line_numbers'
  | 'shell_execution'
  /** A `terminal.*` call named a session id this runtime does not hold. */
  | 'terminal_not_found'
  /** A `terminal.write` reached a session whose shell has already exited. */
  | 'terminal_exited'
  | 'git_execution'
  | 'gh_execution'
  | 'workspace_browser'
  | 'workspace_containment'
  | 'workdir_validation'
  | 'snapshot_conflict'
  | 'snapshot_too_large'
  | 'runtime_update_refused'
  | 'runtime_service_unsupported'
  | 'runtime_service_no_session_bus'
  | 'runtime_service_setup_pending'
  | 'runtime_service_unconfigured'
  | 'runtime_service_binary_missing'
  | 'library_backup_missing'
  | 'mcp_connection'
  | 'mcp_call'
  | 'mcp_session_missing';

export class RuntimeServiceError extends Error {
  constructor(
    readonly kind: RuntimeServiceErrorKind,
    message: string,
    readonly data: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'RuntimeServiceError';
  }
}

export class PathAccessError extends RuntimeServiceError {
  constructor(message: string, data: Readonly<Record<string, unknown>> = {}) {
    super('path_access', message, data);
    this.name = 'PathAccessError';
  }
}

/**
 * A read was refused because the file is past the ceiling the call carried.
 *
 * A `path_access` refusal like any other on the wire — the subclass exists so an
 * in-process caller with a better remediation to offer can recognise the case
 * without matching on message text. Class identity does not survive the
 * transport (every `RuntimeServiceError` flattens to `kind` + `data`), so this
 * stays runtime-internal and is not exported from the package barrel; the
 * `limitBytes` datum is what reaches a hub caller, as `details.limitBytes`.
 */
export class FileTooLargeError extends PathAccessError {
  constructor(message: string, limitBytes: number) {
    super(message, { limitBytes });
    this.name = 'FileTooLargeError';
  }
}

export class RuntimeToolArgumentError extends RuntimeServiceError {
  constructor(message: string) {
    super('tool_argument', message);
    this.name = 'RuntimeToolArgumentError';
  }
}

/** A live update was malformed, out of sequence, unsafe, or could not publish. */
export class RuntimeUpdateError extends RuntimeServiceError {
  constructor(message: string, data: Readonly<Record<string, unknown>> = {}) {
    super('runtime_update_refused', message, data);
    this.name = 'RuntimeUpdateError';
  }
}

/** User-level service install/status refused or unsupported on this machine. */
export class RuntimeServiceManagementError extends RuntimeServiceError {
  constructor(
    kind:
      | 'runtime_service_unsupported'
      | 'runtime_service_no_session_bus'
      | 'runtime_service_setup_pending'
      | 'runtime_service_unconfigured'
      | 'runtime_service_binary_missing',
    message: string,
    data: Readonly<Record<string, unknown>> = {}
  ) {
    super(kind, message, data);
    this.name = 'RuntimeServiceManagementError';
  }
}

/**
 * Kind carried in `details.kind` when a named backup set is gone.
 *
 * The class does not survive the protocol boundary — `errorPayloadFor` flattens
 * every service error to code `INTERNAL` plus its kind — so this constant is
 * what lets the hub answer 404 instead of matching on the message text. It goes
 * in `details`, which is an open record on the wire. Consent refusals are the
 * exception: they travel as the reserved `DENIED` code.
 */
export const LIBRARY_BACKUP_MISSING_KIND =
  'library_backup_missing' satisfies RuntimeServiceErrorKind;

/**
 * Maps what a runtime handler threw onto the wire error the peer receives.
 *
 * Consent refusals travel as the reserved `DENIED`, a refused live update as
 * the application's own `RUNTIME_UPDATE_REFUSED`, and every other service
 * error as `INTERNAL` carrying its `kind` — which is what lets a hub answer
 * 404 for a missing backup set instead of matching on message text. An
 * `AbortError` is left alone: the session maps it to `CANCELLED`.
 *
 * @example
 * throw toRemoteError(new LibraryBackupMissingError('set "a1" is gone'));
 * // RemoteError INTERNAL, details.kind === 'library_backup_missing'
 */
export function toRemoteError(error: unknown): unknown {
  if (!(error instanceof RuntimeServiceError)) return error;
  if (error.kind === CONSENT_DENIED_KIND) {
    const missing = Array.isArray(error.data.missing)
      ? error.data.missing.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return new RemoteError(RESERVED_ERROR_CODES.DENIED, error.message, {
      kind: error.kind,
      ...error.data,
      capability: typeof error.data.capability === 'string' ? error.data.capability : missing[0],
    });
  }
  if (error.kind === 'runtime_update_refused') {
    return new RemoteError(RUNTIME_UPDATE_REFUSED, error.message, {
      kind: error.kind,
      ...error.data,
    });
  }
  return new RemoteError(RESERVED_ERROR_CODES.INTERNAL, error.message, {
    kind: error.kind,
    ...error.data,
  });
}

/**
 * The machine's owner has not granted a capability the method needs.
 *
 * Distinct from a crash so the turn pipeline can render a policy refusal
 * instead of treating the call as an infrastructure failure.
 */
export class RuntimeConsentDeniedError extends Error {
  constructor(
    message: string,
    readonly details: Readonly<{
      readonly capability?: string;
      readonly method?: string;
      readonly slot?: string;
      readonly missing?: readonly string[];
    }> = {}
  ) {
    super(message);
    this.name = 'RuntimeConsentDeniedError';
  }
}
