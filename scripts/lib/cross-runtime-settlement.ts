/**
 * Settle every cross-runtime target before returning results or the first failure.
 *
 * @example
 * await settleCrossRuntimeResolutions(['linux-x64'], async (target) => target);
 */
export async function settleCrossRuntimeResolutions<T, R>(
  targets: readonly T[],
  resolve: (target: T) => Promise<R>
): Promise<R[]> {
  let failed = false;
  let firstFailure: unknown;
  const pending = targets.map(async (target) => {
    try {
      return await resolve(target);
    } catch (caught) {
      if (!failed) {
        failed = true;
        firstFailure = caught;
      }
      throw caught;
    }
  });
  const settled = await Promise.allSettled(pending);
  if (failed) throw firstFailure;
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
