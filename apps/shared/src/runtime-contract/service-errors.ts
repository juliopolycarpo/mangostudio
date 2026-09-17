/**
 * One class per `details.kind`, for both ends of the boundary.
 *
 * A runtime handler throws one of these and the session flattens it to a wire
 * error; a hub receives that wire error and rebuilds the same class from
 * `details.kind`. The two halves have to agree on which kind means which
 * remediation, and a class defined twice is two chances to disagree — so the
 * table is declared once, here, beside the {@link RuntimeServiceErrorKind}
 * union it is keyed by.
 *
 * Declaring them together is *not* a claim that the class crosses a process.
 * It cannot: `toRemoteError` reduces every one of these to a code plus
 * `details`, and the hub narrows on `details.kind` to pick the constructor
 * again. The identity is rebuilt on arrival, which is exactly what a peer
 * written in another language does with the same string.
 *
 * A leaf, like {@link ./errors}: it imports one type and nothing else, so no
 * module can be pulled into a cycle by needing an error class.
 */

import type { RuntimeServiceErrorKind } from './errors';

/**
 * A refusal a runtime method can report, carrying the `kind` and the `data`
 * that survive the transport.
 *
 * @example
 * throw new RuntimeServiceError('terminal_not_found', 'No terminal "t1".', { sessionId: 't1' });
 */
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

/** A path was outside what the call was allowed to touch, or could not be used. */
export class PathAccessError extends RuntimeServiceError {
  constructor(message: string, data: Readonly<Record<string, unknown>> = {}) {
    super('path_access', message, data);
    this.name = 'PathAccessError';
  }
}

/**
 * The target of a write exists and is not a regular file.
 *
 * A `path_access` refusal on the wire; the subclass lets a caller on the same
 * machine offer a better remediation without matching on message text.
 */
export class RegularFileWriteError extends RuntimeServiceError {
  constructor(message: string) {
    super('path_access', message);
    this.name = 'RegularFileWriteError';
  }
}

/** A tool argument was missing, malformed, or out of range. */
export class RuntimeToolArgumentError extends RuntimeServiceError {
  constructor(message: string) {
    super('tool_argument', message);
    this.name = 'RuntimeToolArgumentError';
  }
}

/** The grep pattern is not a regular expression this engine can compile. */
export class GrepPatternError extends RuntimeServiceError {
  constructor(message: string) {
    super('grep_pattern', message);
    this.name = 'GrepPatternError';
  }
}

/** A shell child could not be started, or ended in a way the caller must see. */
export class ShellExecutionError extends RuntimeServiceError {
  constructor(message: string) {
    super('shell_execution', message);
    this.name = 'ShellExecutionError';
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

/** A workspace path was empty, or relative where an absolute one was required. */
export class WorkspacePathError extends RuntimeServiceError {
  readonly code = 'VALIDATION';

  constructor(message: string) {
    super('workdir_validation', message, { code: 'VALIDATION' });
    this.name = 'WorkspacePathError';
  }
}

/** A checkpoint revert found the file changed since the snapshot was taken. */
export class RuntimeSnapshotConflictError extends RuntimeServiceError {
  constructor(readonly resolvedPath: string) {
    super(
      'snapshot_conflict',
      `Cannot revert "${resolvedPath}": the file changed on disk since this assistant message completed.`,
      { resolvedPath }
    );
    this.name = 'RuntimeSnapshotConflictError';
  }
}

/** A mutation named a file this chat never read. */
export class FileNotReadError extends RuntimeServiceError {
  constructor(resolvedPath: string) {
    super('file_not_read', `You must read "${resolvedPath}" with read_file before modifying it.`, {
      resolvedPath,
    });
    this.name = 'FileNotReadError';
  }
}

/** A mutation named a file this chat has only read part of. */
export class PartialReadError extends RuntimeServiceError {
  constructor(resolvedPath: string, coveredThroughLine: number) {
    const observed =
      coveredThroughLine > 0
        ? `only lines 1-${coveredThroughLine} have been read`
        : 'it has not been read from line 1';
    super(
      'partial_read',
      `Cannot modify "${resolvedPath}": ${observed} in this chat. A safe mutation requires a ` +
        'complete view of the current file, so read the remaining lines with read_file ' +
        '(startLine/maxLines) first.',
      { resolvedPath, coveredThroughLine }
    );
    this.name = 'PartialReadError';
  }
}

/** The file changed on disk since this chat last read it. */
export class StaleFileError extends RuntimeServiceError {
  constructor(resolvedPath: string) {
    super(
      'stale_file',
      `"${resolvedPath}" changed on disk since it was last read (content hash mismatch). ` +
        'Re-read the file and retry with the current content.',
      { resolvedPath }
    );
    this.name = 'StaleFileError';
  }
}

/** An earlier edit in this chat moved the lines a range-addressed edit quoted. */
export class StaleLineNumbersError extends RuntimeServiceError {
  constructor(resolvedPath: string, validThroughLine: number) {
    const remaining =
      validThroughLine > 0
        ? `only lines 1-${validThroughLine} still match the last read`
        : 'no line numbers still match the last read';
    super(
      'stale_line_numbers',
      `Line numbers for "${resolvedPath}" are stale: an earlier edit in this chat changed the ` +
        `file's line count, so ${remaining}. Re-read the file with read_file to get the ` +
        'current numbering before replacing this range.',
      { resolvedPath, validThroughLine }
    );
    this.name = 'StaleLineNumbersError';
  }
}

/**
 * A line-addressed edit quoted numbers a byte view never assigned.
 *
 * Distinct from {@link StaleLineNumbersError}: the file did not change on disk
 * and nothing is stale — the last read simply never produced line numbers.
 */
export class UnobservedLineNumbersError extends RuntimeServiceError {
  constructor(resolvedPath: string) {
    super(
      'unobserved_line_numbers',
      `Line numbers for "${resolvedPath}" were never observed: the last read was a byte view ` +
        '(hex or base64), which does not assign line numbers. Re-read the file as text with ' +
        'read_file first, then retry replacing this range.',
      { resolvedPath }
    );
    this.name = 'UnobservedLineNumbersError';
  }
}

/**
 * The machine's owner has not granted a capability the method needs.
 *
 * Not a {@link RuntimeServiceError}: a consent refusal travels as the reserved
 * `DENIED` code rather than `INTERNAL` plus a kind, so the turn pipeline can
 * render a policy refusal instead of treating the call as an infrastructure
 * failure.
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
