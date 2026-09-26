/**
 * Races `promise` against `signal`, rejecting with `onAbort()` the moment the
 * signal aborts. The original promise is raced, never replaced, and it is not
 * awaited again once the race settles, so its eventual rejection is caught
 * here instead of surfacing as an unhandled rejection.
 *
 * @example
 * const row = await raceAgainstAbort(query, signal, () => new Error('Lookup was cancelled.'));
 */
export function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => unknown
): Promise<T> {
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.reject(onAbort());
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(onAbort());
  signal.addEventListener('abort', abort, { once: true });
  return Promise.race([promise, aborted.promise]).finally(() => {
    signal.removeEventListener('abort', abort);
  });
}
