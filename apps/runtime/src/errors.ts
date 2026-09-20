/**
 * The throw side of the error boundary: the classes come from the shared
 * contract, and this module maps what a handler threw onto the wire.
 *
 * The class table lives in `@mangostudio/shared/runtime-contract` because both
 * ends need it — the runtime to throw, the hub to rebuild from `details.kind`.
 * What stays here is the part only a runtime does: flattening a class into a
 * `RemoteError`, plus the two errors that never leave this process.
 */

import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import {
  CONSENT_DENIED_KIND,
  PathAccessError,
  RUNTIME_UPDATE_REFUSED,
  RuntimeServiceError,
} from '@mangostudio/shared/runtime-contract';

export {
  FileNotReadError,
  GrepPatternError,
  LIBRARY_BACKUP_MISSING_KIND,
  PartialReadError,
  PathAccessError,
  RegularFileWriteError,
  RuntimeConsentDeniedError,
  RuntimeServiceError,
  RuntimeServiceManagementError,
  RuntimeSnapshotConflictError,
  RuntimeToolArgumentError,
  ShellExecutionError,
  StaleFileError,
  StaleLineNumbersError,
  UnobservedLineNumbersError,
  WorkspacePathError,
} from '@mangostudio/shared/runtime-contract';

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

/** A live update was malformed, out of sequence, unsafe, or could not publish. */
export class RuntimeUpdateError extends RuntimeServiceError {
  constructor(message: string, data: Readonly<Record<string, unknown>> = {}) {
    super('runtime_update_refused', message, data);
    this.name = 'RuntimeUpdateError';
  }
}

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
 * throw toRemoteError(new RuntimeServiceError('library_backup_missing', 'set "a1" is gone'));
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
