/**
 * Per-socket outbound queue and backpressure discipline for `/api/terminal/:id`.
 *
 * A pure module deliberately kept free of Elysia, Bun's `ServerWebSocket`, and
 * the terminal wire codec: it deals only in already-encoded `Uint8Array`
 * frames and the three numbers Bun's own socket reports back. That is what
 * lets a `FakeSocket` drive every branch — `-1`, `0`, and the queue-overflow
 * discard — without opening a real connection.
 *
 * `send` returning `-1` means the frame was accepted and buffered under
 * backpressure, not refused: the frame is already gone from the queue either
 * way, and `-1` only pauses *further* sends until `drain()` runs. Resending a
 * `-1` frame would duplicate bytes into the terminal. `0` means the socket
 * dropped the frame — with the shared `closeOnBackpressureLimit: true`, that
 * is the socket closing anyway, so the relay closes it with a typed reason.
 *
 * // Usage:
 * //   const relay = createTerminalSocketRelay({ send, getBufferedAmount, close, buildOverflowNotice });
 * //   relay.push(dataFrame);
 * //   // on the socket's `drain` event:
 * //   relay.drain();
 */

import {
  TERMINAL_HUB_QUEUE_MAX_BYTES,
  TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES,
} from '@mangostudio/shared/terminal';

export interface TerminalSocketRelayDeps {
  /** Bun's `ServerWebSocket.send` result: `>0` bytes sent, `-1` buffered, `0` dropped. */
  readonly send: (frame: Uint8Array) => number;
  readonly getBufferedAmount: () => number;
  readonly close: (code: number, reason: string) => void;
  /** Builds the one `notice {kind:'queue_overflow'}` frame for the bytes just discarded. */
  readonly buildOverflowNotice: (bytes: number) => Uint8Array;
  /** Defaults to `TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES`. */
  readonly highWaterBytes?: number;
  /** Defaults to `TERMINAL_HUB_QUEUE_MAX_BYTES`. */
  readonly maxQueueBytes?: number;
}

export interface TerminalSocketRelay {
  /** Enqueues a frame, discarding the oldest queued frames first on overflow. */
  push(frame: Uint8Array): void;
  /** Resumes flushing the queue; call this from the socket's `drain` handler. */
  drain(): void;
  /** Bytes currently queued and not yet handed to `send`. */
  queuedBytes(): number;
}

const DROPPED_CLOSE_CODE = 1011;
const DROPPED_CLOSE_REASON = 'Send buffer exceeded';

export function createTerminalSocketRelay(deps: TerminalSocketRelayDeps): TerminalSocketRelay {
  const highWaterBytes = deps.highWaterBytes ?? TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES;
  const maxQueueBytes = deps.maxQueueBytes ?? TERMINAL_HUB_QUEUE_MAX_BYTES;
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let closed = false;
  // Set on a `-1` result and cleared only by `drain()`. `getBufferedAmount()`
  // ought to reflect the same backpressure on a real socket, but this flag is
  // the relay's own memory of "stop until told to resume" rather than a
  // re-derivation of it — a `send` a caller stubbed without also growing its
  // buffered-amount report must not be reattempted before `drain()` says so.
  let waitingForDrain = false;

  function pump(): void {
    if (waitingForDrain) return;
    while (!closed && queue.length > 0) {
      const next = queue[0] as Uint8Array;
      if (deps.getBufferedAmount() + next.byteLength > highWaterBytes) return;

      const result = deps.send(next);
      queue.shift();
      queuedBytes -= next.byteLength;

      if (result === 0) {
        closed = true;
        deps.close(DROPPED_CLOSE_CODE, DROPPED_CLOSE_REASON);
        return;
      }
      if (result < 0) {
        waitingForDrain = true; // Buffered; wait for drain before sending more.
        return;
      }
    }
  }

  function discardOldestUntilWithinBudget(incomingBytes: number): void {
    let discarded = 0;
    while (queuedBytes + incomingBytes > maxQueueBytes && queue.length > 0) {
      const oldest = queue.shift() as Uint8Array;
      queuedBytes -= oldest.byteLength;
      discarded += oldest.byteLength;
    }
    if (discarded === 0) return;
    const notice = deps.buildOverflowNotice(discarded);
    queue.push(notice);
    queuedBytes += notice.byteLength;
  }

  return {
    push(frame) {
      if (closed) return;
      discardOldestUntilWithinBudget(frame.byteLength);
      queue.push(frame);
      queuedBytes += frame.byteLength;
      pump();
    },
    drain() {
      waitingForDrain = false;
      pump();
    },
    queuedBytes() {
      return queuedBytes;
    },
  };
}
