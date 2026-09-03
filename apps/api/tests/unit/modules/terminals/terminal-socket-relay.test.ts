import { describe, expect, test } from 'bun:test';
import {
  TERMINAL_CLIENT_MESSAGE_MAX_BYTES,
  TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES,
} from '@mangostudio/shared/terminal';
import { REALTIME_WEBSOCKET_OPTIONS } from '../../../../src/modules/realtime/http/realtime-routes';
import {
  createTerminalSocketRelay,
  type TerminalSocketRelayDeps,
} from '../../../../src/modules/terminals/application/terminal-socket-relay';

/**
 * Named fake standing in for Bun's `ServerWebSocket`: `nextSendResult`
 * chooses what `send()` reports next, mirroring the three real outcomes
 * (`>0` sent, `-1` buffered under backpressure, `0` dropped).
 */
class FakeSocket {
  readonly sent: Uint8Array[] = [];
  bufferedAmount = 0;
  nextSendResult = 1;
  closed: { code: number; reason: string } | null = null;

  send(frame: Uint8Array): number {
    this.sent.push(frame);
    return this.nextSendResult;
  }

  getBufferedAmount(): number {
    return this.bufferedAmount;
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function bytes(length: number, fill = 1): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function relayDepsFor(
  socket: FakeSocket,
  overrides: Partial<TerminalSocketRelayDeps> = {}
): TerminalSocketRelayDeps {
  return {
    send: (frame) => socket.send(frame),
    getBufferedAmount: () => socket.getBufferedAmount(),
    close: (code, reason) => socket.close(code, reason),
    buildOverflowNotice: (discardedBytes) => bytes(1, discardedBytes),
    ...overrides,
  };
}

describe('createTerminalSocketRelay', () => {
  test('sends a frame immediately when there is room under the high-water mark', () => {
    const socket = new FakeSocket();
    const relay = createTerminalSocketRelay(relayDepsFor(socket, { highWaterBytes: 1_000 }));

    relay.push(bytes(10));

    expect(socket.sent).toEqual([bytes(10)]);
    expect(relay.queuedBytes()).toBe(0);
  });

  test('a -1 result pauses further sends without resending the buffered frame', () => {
    const socket = new FakeSocket();
    socket.nextSendResult = -1;
    const relay = createTerminalSocketRelay(relayDepsFor(socket, { highWaterBytes: 1_000 }));

    relay.push(bytes(10));
    expect(socket.sent).toHaveLength(1);

    // A second frame queues behind the paused send rather than being attempted.
    relay.push(bytes(10));
    expect(socket.sent).toHaveLength(1);
    expect(relay.queuedBytes()).toBe(10);

    // drain() resumes; the -1 frame is never sent again.
    socket.nextSendResult = 1;
    relay.drain();
    expect(socket.sent).toHaveLength(2);
    expect(relay.queuedBytes()).toBe(0);
  });

  test('a 0 result closes the socket and does not resend', () => {
    const socket = new FakeSocket();
    socket.nextSendResult = 0;
    const relay = createTerminalSocketRelay(relayDepsFor(socket, { highWaterBytes: 1_000 }));

    relay.push(bytes(10));

    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toEqual({ code: 1011, reason: 'Send buffer exceeded' });

    // Further pushes are no-ops once the relay has closed.
    relay.push(bytes(10));
    expect(socket.sent).toHaveLength(1);
  });

  test('holds sends above the high-water mark until buffered bytes drop', () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 990;
    const relay = createTerminalSocketRelay(relayDepsFor(socket, { highWaterBytes: 1_000 }));

    relay.push(bytes(20)); // 990 + 20 > 1000: held.
    expect(socket.sent).toHaveLength(0);
    expect(relay.queuedBytes()).toBe(20);

    socket.bufferedAmount = 0;
    relay.drain();
    expect(socket.sent).toHaveLength(1);
    expect(relay.queuedBytes()).toBe(0);
  });

  test('discards the oldest queued frames and pushes one overflow notice past the queue cap', () => {
    const socket = new FakeSocket();
    // Always above the (tiny) high-water mark, so nothing ever sends and
    // pushed frames simply accumulate — isolating the overflow accounting
    // from the send path.
    socket.bufferedAmount = 1_000;
    const relay = createTerminalSocketRelay(
      relayDepsFor(socket, { highWaterBytes: 1, maxQueueBytes: 25 })
    );

    relay.push(bytes(10, 1)); // queue: [10] = 10 bytes
    relay.push(bytes(10, 2)); // queue: [10, 10] = 20 bytes
    relay.push(bytes(10, 3)); // 20 + 10 = 30 > 25: discard the oldest (10 bytes), then queue the notice

    expect(socket.sent).toHaveLength(0);
    // 10 (frame 2, survived) + 10 (frame 3, just pushed) + 1 (the one-byte
    // fake overflow notice) — frame 1 (fill 1) was discarded to make room.
    expect(relay.queuedBytes()).toBe(21);
  });

  test('an overflow notice sits ahead of the frame that triggered the discard', () => {
    const socket = new FakeSocket();
    const relay = createTerminalSocketRelay(
      relayDepsFor(socket, { highWaterBytes: 1_000, maxQueueBytes: 15 })
    );
    // Hold everything after the first frame in the queue by pausing on -1.
    socket.nextSendResult = -1;

    relay.push(bytes(10, 1)); // sent immediately (queue was empty), then paused
    relay.push(bytes(10, 2)); // queued while paused: 10 bytes
    relay.push(bytes(10, 3)); // 10 + 10 > 15: discards frame 2, queues a notice, then frame 3

    socket.nextSendResult = 1;
    relay.drain();

    expect(socket.sent).toEqual([bytes(10, 1), bytes(1, 10), bytes(10, 3)]);
  });

  test('discarding never touches a frame that has already been handed to send()', () => {
    const socket = new FakeSocket();
    const relay = createTerminalSocketRelay(relayDepsFor(socket, { maxQueueBytes: 15 }));

    relay.push(bytes(10, 1)); // Sent immediately: the queue was empty, so nothing to discard.
    relay.push(bytes(10, 2)); // Sent immediately too, for the same reason.

    expect(socket.sent).toEqual([bytes(10, 1), bytes(10, 2)]);
    expect(relay.queuedBytes()).toBe(0);
  });
});

/**
 * The one pin the shared package cannot hold: `@mangostudio/shared/terminal`
 * cannot see the hub's socket options, so nothing there catches a client limit
 * raised past what the transport will carry.
 */
describe('terminal socket limits against the shared websocket options', () => {
  test('the largest client message still fits one websocket payload', () => {
    // uWebSockets refuses a payload *greater* than `maxPayloadLength`, so equal
    // is legal and is what the wire is tuned to. Raising the client limit alone
    // closes the socket with 1009 on the first full-size paste.
    expect(TERMINAL_CLIENT_MESSAGE_MAX_BYTES).toBeLessThanOrEqual(
      REALTIME_WEBSOCKET_OPTIONS.maxPayloadLength
    );
  });

  test('the relay holds its queue below the backpressure limit that closes a socket', () => {
    expect(TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES).toBeLessThan(
      REALTIME_WEBSOCKET_OPTIONS.backpressureLimit
    );
  });
});
