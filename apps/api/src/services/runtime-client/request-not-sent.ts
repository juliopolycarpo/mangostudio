/**
 * The one runtime-request failure that proves nothing reached the peer.
 *
 * The protocol session rejects a request with `UNAVAILABLE` both when it was
 * already closed before the frame was written and when it closed after the
 * frame was written but before the reply came back — and a runtime can answer
 * `UNAVAILABLE` itself. Only the first of those three says the peer never saw
 * the request, and that is the one fact a caller needs before it may submit
 * the same work again. This class is that fact, thrown only from the pre-send
 * check in `openHubSession`, before the SDK is called at all.
 *
 * It stays a `RemoteError` with the `UNAVAILABLE` code on purpose: every
 * existing caller that branches on "the runtime is gone" keeps working, and
 * `RuntimeClient` still reports the connection as unavailable.
 */

import { RESERVED_ERROR_CODES, RemoteError, type SessionClosure } from '@mangostudio/protocol';

export class RuntimeRequestNotSentError extends RemoteError {
  constructor(method: string, closure: SessionClosure | undefined) {
    super(
      RESERVED_ERROR_CODES.UNAVAILABLE,
      `Request "${method}" was not sent: the runtime session was already ${
        closure ? `closed (code ${closure.code})` : 'closed'
      }; expected an open session.`,
      { method, dispatch: 'not-sent', ...(closure ? { closeCode: closure.code } : {}) }
    );
    this.name = 'RuntimeRequestNotSentError';
  }
}

/**
 * Whether a request failure proves the request never left this hub.
 *
 * @example
 * if (isRequestNotSent(error)) retryLater(); // nothing reached the runtime
 */
export function isRequestNotSent(error: unknown): error is RuntimeRequestNotSentError {
  return error instanceof RuntimeRequestNotSentError;
}
