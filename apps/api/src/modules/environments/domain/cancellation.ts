/**
 * Refuses to continue once the caller has stopped waiting.
 *
 * Prefer this over `signal.throwIfAborted()` directly: that throws whatever
 * `reason` the signal was aborted with, which need not be an `Error` at all.
 * This always throws a `DOMException` named `AbortError` with a message that
 * says what was cancelled, which is what every catch site along the way
 * expects to classify and report.
 */
export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw new DOMException(message, 'AbortError');
}
