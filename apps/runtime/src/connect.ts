/**
 * The dial-out loop: a runtime that reaches the hub instead of waiting to be
 * reached.
 *
 * Bun's WebSocket client has no built-in reconnect, so the backoff is here, and
 * it reads the hub's close code before deciding what to do with it. Retrying a
 * revoked credential forever is not resilience, it is a machine hammering an
 * endpoint that will never say yes; coming back on the same cadence after being
 * rate limited is the same mistake from the other side.
 */

import {
  isFatalRuntimeCloseCode,
  RUNTIME_CLOSE_CODES,
  RUNTIME_HEARTBEAT_TOPIC,
} from '@mangostudio/shared/runtime-protocol';
import type { RuntimeHost } from './host';
import { startProtocolLiveness } from './liveness';
import { clientWebSocketSink, createWebSocketFramePort } from './transports/websocket';

/** Base of the jittered exponential backoff, doubling to the cap below. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/** Where a rate-limited close restarts from: the wall is real, wait it out. */
const RATE_LIMITED_DELAY_MS = 30_000;
/** Full jitter, so a rack of runtimes reconnecting does not arrive in step. */
const JITTER_RATIO = 0.5;

const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Well under the hub's 60s socket idle timeout, in both directions. */
const LIVENESS_INTERVAL_MS = 20_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface RuntimeConnectOptions {
  readonly hubUrl: string;
  readonly token: string;
  readonly createHost: () => RuntimeHost;
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
      attempt.closeCode === RUNTIME_CLOSE_CODES.RATE_LIMITED
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
  const socket = new WebSocket(options.hubUrl, {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  socket.binaryType = 'arraybuffer';

  const host = options.createHost();
  const port = createWebSocketFramePort({ sink: clientWebSocketSink(socket) });
  socket.addEventListener('message', (event) => port.receive(event.data as ArrayBuffer));

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener(
      'close',
      (event) => {
        port.handleSocketClosed();
        const closeEvent = event as CloseEvent;
        resolve({ code: closeEvent.code, reason: closeEvent.reason });
      },
      { once: true }
    );
  });
  const abort = (): void => socket.close(1000, 'Runtime stopping');
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const opened = await Promise.race([
      new Promise<boolean>((resolve) => {
        socket.addEventListener('open', () => resolve(true), { once: true });
        socket.addEventListener('close', () => resolve(false), { once: true });
      }),
      // A hub can also accept the socket and say nothing; without this the loop
      // would stall on a connection that is neither open nor closed.
      sleepMs(HANDSHAKE_TIMEOUT_MS).then(() => false),
    ]);
    if (!opened) {
      socket.close(1000, 'Handshake timed out');
      return classifyClosure(await closed, false);
    }

    host.attach(port);
    host.start();
    const handshake = await Promise.race([
      host.waitUntilReady().then(
        () => null,
        (error: unknown) => asError(error)
      ),
      // A hub that refuses mid-handshake — a disabled environment discovered
      // after the upgrade, a protocol version it will not serve — says so by
      // closing. The frame port does not turn that into a handshake rejection,
      // so without this the CLI sits out the full timeout before reporting a
      // refusal it already has in hand.
      closed.then(() => new Error('The hub closed the connection during the handshake.')),
      sleepMs(HANDSHAKE_TIMEOUT_MS).then(
        () => new Error('The hub did not acknowledge the protocol handshake in time.')
      ),
    ]);
    if (handshake) {
      socket.close(1000, 'Handshake failed');
      const closure = classifyClosure(await closed, false);
      // A hub that refused the credential has already said why; the local
      // handshake error is only the symptom of that close arriving mid-hello.
      return closure.retry
        ? { ...closure, message: `Protocol handshake failed: ${handshake.message}` }
        : closure;
    }

    const stopLiveness = startProtocolLiveness({
      ping: () => host.ping(),
      onPong: (listener) => host.onPong(listener),
      intervalMs: LIVENESS_INTERVAL_MS,
      onTimeout: () => {
        log('Hub stopped answering protocol pings.');
        socket.close(RUNTIME_CLOSE_CODES.RELEASED, 'Liveness timeout');
      },
    });
    const beat = (): void => {
      host.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: Date.now() } });
    };
    const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    (heartbeat as { unref?: () => void }).unref?.();
    beat();
    log(`Connected to ${options.hubUrl}.`);

    try {
      return classifyClosure(await closed, true);
    } finally {
      stopLiveness();
      clearInterval(heartbeat);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await host.close();
  }
}

function classifyClosure(
  closure: { code: number; reason: string },
  served: boolean
): ConnectionAttempt {
  const detail = closure.reason ? ` (${closure.reason})` : '';
  if (isFatalRuntimeCloseCode(closure.code)) {
    return {
      retry: false,
      served,
      closeCode: closure.code,
      message: fatalClosureMessage(closure.code, detail),
    };
  }
  if (closure.code === RUNTIME_CLOSE_CODES.RATE_LIMITED) {
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
    case RUNTIME_CLOSE_CODES.UNAUTHORIZED:
      return `The hub refused this runtime's pairing token${detail}. Issue a new one from the environment card and run "connect" again with it.`;
    case RUNTIME_CLOSE_CODES.PROTOCOL_MISMATCH:
      return `The hub speaks a runtime protocol this binary does not${detail}. Update the runtime on this machine, then run "connect" again.`;
    case RUNTIME_CLOSE_CODES.SUPERSEDED:
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
  return sleepMs(ms);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
