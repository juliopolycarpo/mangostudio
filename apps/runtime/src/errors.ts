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
  | 'snapshot_too_large';

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
