/**
 * Client-fault failures of the library flows, carrying the status the route
 * should return. Lives in `domain` so preview, apply, removal, and the
 * conflict-resolution service can all raise it without importing each other.
 */

import type { ErrorCode } from '@mangostudio/shared/errors';

export type LibraryRequestErrorStatus = 400 | 404 | 409 | 422;

export class LibraryRequestError extends Error {
  constructor(
    readonly status: LibraryRequestErrorStatus,
    message: string,
    /**
     * Overrides the status's default code. Reserved for refusals a client has
     * to handle differently from every other rejection of the same status: a
     * missing last-copy acknowledgement is a prompt to put in front of the
     * user, not a bug to report, and it is indistinguishable from any other
     * 422 without this.
     */
    readonly code?: ErrorCode
  ) {
    super(message);
    this.name = 'LibraryRequestError';
  }
}
