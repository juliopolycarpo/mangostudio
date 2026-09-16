/**
 * The deadline both connect functions dial under: the caller's `AbortSignal`
 * and a `timeoutMs` composed into the one signal an attempt has to watch.
 *
 * A transport that dials keeps a single settle path this way — everything that
 * can abandon an attempt arrives as an `abort` — and the timer is cleared on
 * every one of those paths, so a connection that was made leaves no live
 * handle behind. Nothing here imports `node:`.
 */

/** A composed deadline, and the cleanup its owner owes on every settle path. */
export interface ConnectDeadline {
  /** Aborts when the caller's signal does, or when the deadline passes. */
  readonly signal: AbortSignal;
  /** Clears the timer and stops forwarding the caller's signal. Idempotent. */
  dispose(): void;
}

/** The two ways a caller bounds a connection attempt. */
export interface ConnectDeadlineOptions {
  /** Abandons the attempt; the transport closes what it opened and rejects. */
  readonly signal?: AbortSignal;
  /** Abandons the attempt after this many milliseconds; no deadline when absent. */
  readonly timeoutMs?: number;
}

/**
 * Composes `options.signal` and `options.timeoutMs` into one signal. The
 * caller's abort is forwarded with its own reason, so a caller that aborted
 * with an error still sees that error; the deadline aborts with a
 * `TimeoutError` naming `target` and the budget it spent.
 *
 * @example
 * const deadline = connectDeadline(url, { timeoutMs: 5000 });
 * deadline.signal.addEventListener('abort', () => reject(abortReason(url, deadline.signal)));
 * // on every settle path:
 * deadline.dispose();
 */
export function connectDeadline(
  target: string,
  options: ConnectDeadlineOptions = {}
): ConnectDeadline {
  const timeoutMs = checkedTimeout(options.timeoutMs);
  const caller = options.signal;
  const controller = new AbortController();
  if (caller?.aborted === true) {
    controller.abort(caller.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }

  const forward = (): void => controller.abort(caller?.reason);
  caller?.addEventListener('abort', forward, { once: true });
  // `AbortSignal.timeout` would do this in one call and could never be
  // cleared; a dial that succeeded must not hold a timer until it fires.
  const timer =
    timeoutMs === undefined
      ? undefined
      : unref(setTimeout(() => controller.abort(timeoutError(target, timeoutMs)), timeoutMs));

  return {
    signal: controller.signal,
    dispose: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      caller?.removeEventListener('abort', forward);
    },
  };
}

/**
 * What a connection attempt abandoned through its deadline rejects with: the
 * reason the caller aborted with when that reason is an error, and a named
 * `AbortError` when it is not.
 *
 * @example
 * abortReason('/run/user/1000/mango-hub.sock', signal).name; // 'AbortError'
 */
export function abortReason(target: string, signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(`The connection to ${target} was aborted.`), {
    name: 'AbortError',
  });
}

/**
 * Stops an armed deadline from being the reason a process stays alive, the way
 * every other timer in the SDK does. A browser's `setTimeout` returns a number
 * with no `unref`, which is why the call is optional rather than typed.
 */
function unref<T>(handle: T): T {
  (handle as unknown as { unref?: () => void }).unref?.();
  return handle;
}

function timeoutError(target: string, timeoutMs: number): Error {
  return Object.assign(
    new Error(
      `The connection to ${target} timed out after ${timeoutMs} ms; expected the peer to accept it.`
    ),
    { name: 'TimeoutError' }
  );
}

function checkedTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `timeoutMs is ${String(timeoutMs)}; expected a positive finite number of milliseconds, or none for no deadline`
    );
  }
  return timeoutMs;
}
