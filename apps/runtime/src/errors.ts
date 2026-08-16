import type { RuntimeErrorCode } from '@mangostudio/shared/runtime-protocol';

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
  | 'shell_execution'
  | 'git_execution'
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
 * exception: they travel as the typed `RUNTIME_DENIED` code.
 */
export const LIBRARY_BACKUP_MISSING_KIND =
  'library_backup_missing' satisfies RuntimeServiceErrorKind;

/**
 * Hub-side mirror of a remote `err` payload. `code` is always a known literal
 * after the protocol client narrows the open wire form.
 */
export class RuntimeRemoteError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'RuntimeRemoteError';
  }
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
