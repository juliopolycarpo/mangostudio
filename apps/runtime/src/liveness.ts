/**
 * Protocol-level liveness for network transports.
 *
 * WebSocket control frames are not usable here: Bun's `sendPings` combined with
 * `idleTimeout: 0` has an open defect (oven-sh/bun#26554), and the server-wide
 * idle timeout is a shared setting the browser bus already owns. Protocol
 * `ping`/`pong` frames travel through the same chunked framing as everything
 * else and are therefore true for whatever the socket is actually doing.
 *
 * Both peers run this. The cadence must sit well under the server's idle
 * timeout, or a quiet-but-healthy socket dies on a timer that knows nothing
 * about the protocol.
 */

interface ProtocolLivenessOptions {
  readonly ping: () => void;
  readonly onPong: (listener: () => void) => () => void;
  readonly intervalMs: number;
  /** Called once, after the timer stops, when a ping went unanswered. */
  readonly onTimeout: () => void;
  /** Overridable so tests do not have to wait out a real interval. */
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

/** Starts the ping cadence. The returned function stops it. */
export function startProtocolLiveness(options: ProtocolLivenessOptions): () => void {
  const schedule = options.setInterval ?? globalThis.setInterval;
  const cancel = options.clearInterval ?? globalThis.clearInterval;
  let awaitingPong = false;
  let stopped = false;

  const detachPong = options.onPong(() => {
    awaitingPong = false;
  });

  const timer = schedule(() => {
    if (stopped) return;
    // One missed round trip is the signal, not a running tally: the interval is
    // already several times the round trip a healthy peer needs, so a second
    // chance only delays a reconnect that has to happen anyway.
    if (awaitingPong) {
      stop();
      options.onTimeout();
      return;
    }
    awaitingPong = true;
    try {
      options.ping();
    } catch {
      // The port is already gone; its own close path reports that.
      stop();
    }
  }, options.intervalMs);

  // A heartbeat must not be the reason a CLI process stays alive.
  (timer as { unref?: () => void }).unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cancel(timer);
    detachPong();
  }

  return stop;
}

/**
 * Ping interval for a peer talking to a hub whose sockets idle out after
 * `idleSeconds`. A third of the window means a missed pong is noticed, and the
 * next ping sent, well before anything calls the socket idle.
 */
export function livenessIntervalFor(idleSeconds: number): number {
  return Math.max(5_000, Math.floor((idleSeconds * 1_000) / 3));
}
