/**
 * Retain a started worker lane until cancellation and settlement finish, even
 * when a readiness or marker assertion fails first.
 * @example
 * await withWorkerLaneCleanup(controller, running, checkCancellation);
 */
export async function withWorkerLaneCleanup<T>(
  controller: AbortController,
  running: Promise<unknown>,
  run: () => Promise<T>
): Promise<T> {
  // Observe rejection immediately: readiness may still be awaiting a marker
  // when the owned lane has already failed.
  const settled = running.then(
    () => undefined,
    (error: unknown) => ({ error })
  );
  let result: { readonly value: T } | { readonly error: unknown };
  try {
    result = { value: await run() };
  } catch (error) {
    result = { error };
  }
  controller.abort();
  const cleanupFailure = await settled;
  if (cleanupFailure) {
    if ('error' in result && result.error !== cleanupFailure.error) {
      throw new AggregateError(
        [result.error, cleanupFailure.error],
        'worker cancellation assertion and lane cleanup failed',
        { cause: result.error }
      );
    }
    throw cleanupFailure.error;
  }
  if ('error' in result) throw result.error;
  return result.value;
}
