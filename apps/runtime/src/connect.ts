/**
 * The dial-out loop: a runtime that reaches the hub instead of waiting to be
 * reached.
 *
 * The WebSocket transport has no built-in reconnect, so the backoff is here,
 * and it reads the hub's close code before deciding what to do with it.
 * Retrying a revoked credential forever is not resilience, it is a machine
 * hammering an endpoint that will never say yes; coming back on the same
 * cadence after being rate limited is the same mistake from the other side.
 */

import {
  CLOSE_CODES,
  isFatalCloseCode,
  type Port,
  type Session,
  type SessionClosure,
} from '@mangostudio/protocol';
import { connectWebSocket } from '@mangostudio/protocol/ws';
import { RUNTIME_HEARTBEAT_TOPIC } from '@mangostudio/shared/runtime-contract';
import {
  createRuntimeSession,
  type RuntimeEventRelay,
  type RuntimeHostDefinition,
  whenRuntimeReleased,
} from './session';

/** Base of the jittered exponential backoff, doubling to the cap below. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/** Where a rate-limited close restarts from: the wall is real, wait it out. */
const RATE_LIMITED_DELAY_MS = 30_000;
/** Full jitter, so a rack of runtimes reconnecting does not arrive in step. */
const JITTER_RATIO = 0.5;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface RuntimeConnectOptions {
  readonly hubUrl: string;
  readonly token: string;
  /** Built once per connection: a reconnect serves a fresh definition. */
  readonly createDefinition: () => RuntimeHostDefinition;
  /** Diagnostics; stdout stays free of anything that is not a protocol frame. */
  readonly log?: (message: string) => void;
  /** Stops the loop. A signal handler aborts it. */
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RuntimeConnectOutcome {
  readonly reason: 'stopped' | 'refused';
  readonly message?: string;
}

/**
 * Dials, serves, and redials until the signal aborts or the hub refuses in a
 * way redialing cannot change.
 *
 * @example
 * await connectToHub({ hubUrl, token, createDefinition: () => createLocalRuntimeHost({ runtimeVersion }) });
 */
export async function connectToHub(options: RuntimeConnectOptions): Promise<RuntimeConnectOutcome> {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? defaultSleep;
  let failures = 0;

  while (!options.signal?.aborted) {
    const attempt = await runOneConnection(options, log);
    if (!attempt.retry) return { reason: 'refused', message: attempt.message };
    if (options.signal?.aborted) break;

    // A connection that actually served starts the backoff over: whatever went
    // wrong the last few times, this machine has just proved it can reach the
    // hub and be accepted.
    failures = attempt.served ? 1 : failures + 1;
    const delay =
      attempt.closeCode === CLOSE_CODES.RATE_LIMITED
        ? RATE_LIMITED_DELAY_MS
        : backoffDelay(failures);
    log(`${attempt.message} Reconnecting in ${Math.round(delay / 1_000)}s.`);
    // Raced against the signal, not merely started under it: a service manager
    // that sends SIGTERM during a 60-second backoff gives the process seconds
    // to stop, and a sleep that ignores the abort spends that budget waiting
    // for a reconnect nobody wants any more.
    await Promise.race([sleep(delay), aborted(options.signal)]);
  }
  return { reason: 'stopped' };
}

/** Resolves when the signal aborts, and never otherwise. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

interface ConnectionAttempt {
  /** False when redialing cannot change the answer. */
  readonly retry: boolean;
  /** True when the connection completed a handshake before it ended. */
  readonly served: boolean;
  readonly message: string;
  readonly closeCode?: number;
}

async function runOneConnection(
  options: RuntimeConnectOptions,
  log: (message: string) => void
): Promise<ConnectionAttempt> {
  let port: Port;
  try {
    port = await connectWebSocket(options.hubUrl, {
      headers: { authorization: `Bearer ${options.token}` },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // Nothing was accepted, so there is no close code to read: the hub is
    // down, the address is wrong, or the dial was aborted. All three are the
    // loop's own business, and none of them is fatal on its own.
    return {
      retry: true,
      served: false,
      message: `Could not reach the hub: ${asError(error).message}`,
    };
  }

  const definition = options.createDefinition();
  const session = createRuntimeSession(port, definition, {
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  });
  const abort = (): void => session.close(CLOSE_CODES.RELEASED, 'Runtime stopping');
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    try {
      await session.ready;
    } catch (error) {
      // A hub that refuses mid-handshake — a disabled environment discovered
      // after the upgrade, a protocol version it will not serve — says so by
      // closing, and that close code is the better answer. The local handshake
      // error is only the symptom of it arriving mid-hello.
      const closure = classifyClosure(session.closure, false);
      return closure.retry
        ? { ...closure, message: `Protocol handshake failed: ${asError(error).message}` }
        : closure;
    }

    const stopHeartbeat = startHeartbeat(definition.events);
    log(`Connected to ${options.hubUrl}.`);
    try {
      return classifyClosure(await whenClosed(session), true);
    } finally {
      stopHeartbeat();
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    // Closed before the wait below, and unconditionally: `whenRuntimeReleased`
    // only settles once the session has ended, so a handshake that failed
    // without the transport dropping would hang the loop here.
    session.close(CLOSE_CODES.RELEASED, 'Runtime stopping');
    // Teardown reaps external-agent sessions and vendor process trees, and the
    // next dial rebuilds all of it, so the loop waits for the old one to let go
    // before it asks for another.
    await whenRuntimeReleased(session);
  }
}

/** Settles with the closure that ended `session`. */
function whenClosed(session: Session): Promise<SessionClosure> {
  return new Promise<SessionClosure>((resolve) => {
    session.onClose(resolve);
  });
}

/**
 * Publishes the keep-alive the hub records a credential's use from, until the
 * returned function stops it.
 *
 * Through the relay rather than the session, because that is the path every
 * other runtime event takes: whichever session is currently bound carries it,
 * and one that is gone drops it.
 *
 * @example
 * const stop = startHeartbeat(definition.events);
 */
function startHeartbeat(events: RuntimeEventRelay): () => void {
  const beat = (): void => {
    events.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: Date.now() } });
  };
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  beat();
  return () => clearInterval(timer);
}

function classifyClosure(closure: SessionClosure | undefined, served: boolean): ConnectionAttempt {
  if (!closure) {
    return { retry: true, served, message: 'The connection to the hub ended without a reason.' };
  }
  const detail = closure.reason ? ` (${closure.reason})` : '';
  if (isFatalCloseCode(closure.code)) {
    return {
      retry: false,
      served,
      closeCode: closure.code,
      message: fatalClosureMessage(closure.code, detail),
    };
  }
  if (closure.code === CLOSE_CODES.RATE_LIMITED) {
    return {
      retry: true,
      served,
      closeCode: closure.code,
      message: 'The hub is rate limiting connections from this address.',
    };
  }
  return {
    retry: true,
    served,
    closeCode: closure.code,
    message: `Connection to the hub ended (${closure.code}${closure.reason ? `: ${closure.reason}` : ''}).`,
  };
}

/**
 * What to tell the operator about a close that redialing cannot fix. Each of
 * these names the one thing that would change the answer, because "connection
 * refused, retrying" on a loop is how a broken pairing goes unnoticed for a
 * week.
 */
function fatalClosureMessage(code: number, detail: string): string {
  switch (code) {
    case CLOSE_CODES.UNAUTHORIZED:
      return `The hub refused this runtime's pairing token${detail}. Issue a new one from the environment card and run "connect" again with it.`;
    case CLOSE_CODES.PROTOCOL_MISMATCH:
      return `The hub speaks a runtime protocol this binary does not${detail}. Update the runtime on this machine, then run "connect" again.`;
    case CLOSE_CODES.SUPERSEDED:
      // Stopping rather than redialing: another process holds this credential,
      // and a runtime that takes it back on every reconnect just trades the
      // environment back and forth, dropping in-flight calls each time. Which
      // of the two should be running is a decision only an operator has.
      return `Another runtime took over this environment${detail}. Two machines are sharing one pairing token — stop the one that should not have it, or issue a separate token, then run "connect" again.`;
    default:
      return `The hub refused this environment${detail}. Enable it in MangoStudio, then run "connect" again.`;
  }
}

/** Full jitter: uniform over the upper half of each doubled window. */
function backoffDelay(failures: number): number {
  const window = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1),
    RECONNECT_MAX_DELAY_MS
  );
  return Math.round(window * (1 - JITTER_RATIO + Math.random() * JITTER_RATIO));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
