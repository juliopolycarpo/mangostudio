/**
 * Waits for a promise to reject and hands back the reason, for a test that
 * wants to assert on it.
 *
 * Bun's `expect(promise).rejects` matcher does not pump libuv-backed I/O on
 * Windows while it waits (observed on Bun 1.4.0 and 1.4.2): a request whose
 * answer must cross a named pipe or a child's stdio never settles under it.
 * Settling the promise with plain `then` handlers keeps the event loop alive
 * on every platform, so every transport test awaits rejections this way.
 *
 * @example
 * expect(await rejectionOf(session.request('test.absent', {}))).toMatchObject({
 *   code: 'METHOD_UNSUPPORTED',
 * });
 */
export function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(
        `expected the promise to reject, but it resolved with ${JSON.stringify(value)}`
      );
    },
    (reason: unknown) => reason
  );
}
