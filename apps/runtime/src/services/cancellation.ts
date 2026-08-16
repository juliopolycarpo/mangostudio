/**
 * One way for a runtime method to refuse a call the hub gave up on.
 *
 * The rule every service follows: **a runtime method may refuse before it
 * mutates, and must not abandon a mutation in progress.** A cancelled write that
 * stopped between the temporary file and the rename, or a cancelled revert that
 * stopped halfway down its operation list, leaves the filesystem in a state no
 * caller asked for and no checkpoint describes. Refusing early costs nothing;
 * refusing late costs correctness.
 *
 * So the useful cancellation points are the ones before the first write, plus
 * the ones inside a loop that has not written yet — walking a directory,
 * hashing a set of paths. Once bytes start moving, the call finishes.
 */

/**
 * Refusal raised when the call was cancelled.
 *
 * `name` is `AbortError` because that is what the host's error mapping reads to
 * answer the hub `CANCELLED` instead of `INTERNAL` — a cancelled call is not a
 * failed one, and the tool result the user sees differs accordingly. The host
 * maps from this name, not from the signal being aborted, so a mutation that
 * failed after it had already begun still reports as that failure.
 */
class RuntimeCancelledError extends Error {
  constructor() {
    super('Runtime call was cancelled.');
    this.name = 'AbortError';
  }
}

/**
 * Refuses the call if the hub has already cancelled it.
 *
 * Prefer this over `signal.throwIfAborted()`: that throws whatever `reason` the
 * hub happened to abort with, which need not be an `Error` at all, while the
 * walks below rewrite an unrecognised throw into a path failure.
 *
 * // Usage: throwIfAborted(signal);
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new RuntimeCancelledError();
}
