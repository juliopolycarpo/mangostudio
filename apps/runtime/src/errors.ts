import type { RuntimeErrorCode } from '@mangostudio/shared/runtime-protocol';

export type RuntimeServiceErrorKind =
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
  constructor(message: string) {
    super('path_access', message);
    this.name = 'PathAccessError';
  }
}

export class RuntimeToolArgumentError extends RuntimeServiceError {
  constructor(message: string) {
    super('tool_argument', message);
    this.name = 'RuntimeToolArgumentError';
  }
}

/**
 * Kind carried in `details.kind` when a named backup set is gone.
 *
 * The class does not survive the protocol boundary — `errorPayloadFor` flattens
 * every service error to code `INTERNAL` plus its kind — so this constant is
 * what lets the hub answer 404 instead of matching on the message text. It goes
 * in `details`, which is an open record on the wire, rather than in
 * `RuntimeErrorCodeSchema`, whose closed union an older peer would reject.
 */
export const LIBRARY_BACKUP_MISSING_KIND =
  'library_backup_missing' satisfies RuntimeServiceErrorKind;

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
