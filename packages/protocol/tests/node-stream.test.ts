import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { CLOSE_CODES } from '../src/close';
import type { PortClosure } from '../src/port';
import type { Frame } from '../src/schemas/frames';
import { createStreamPort } from '../src/transports/node-stream';

const PING = '{"type":"ping"}\n';
const PONG = '{"type":"pong"}\n';

/** One event loop turn: long enough for a deferred read to be delivered. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Stands in for `setImmediate` so a test can run each turn itself and see what
 * a callback threw, which the real one would report as an uncaught exception.
 */
class ManualImmediates {
  readonly #original = globalThis.setImmediate;
  #queued: Array<() => void> = [];

  constructor() {
    globalThis.setImmediate = ((callback: () => void) => {
      this.#queued.push(callback);
    }) as unknown as typeof setImmediate;
  }

  /** Runs every turn, including the ones a turn schedules, and returns what they threw. */
  runAll(): unknown[] {
    const thrown: unknown[] = [];
    while (this.#queued.length > 0) {
      const turn = this.#queued;
      this.#queued = [];
      for (const callback of turn) {
        try {
          callback();
        } catch (error) {
          thrown.push(error);
        }
      }
    }
    return thrown;
  }

  restore(): void {
    globalThis.setImmediate = this.#original;
  }
}

/** A port over two pipes, recording what it delivers and whether a read callback was running. */
function openPort(deferReads: boolean) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const handle = createStreamPort(readable, writable, { deferReads });
  const frames: Frame[] = [];
  const deliveredInsideReadCallback: boolean[] = [];
  const closures: PortClosure[] = [];
  const order: string[] = [];
  let insideReadCallback = false;
  handle.port.onFrame((frame) => {
    frames.push(frame);
    order.push(frame.type);
    deliveredInsideReadCallback.push(insideReadCallback);
  });
  handle.port.onClosed((closure) => {
    closures.push(closure);
    order.push(`closure:${closure.kind}`);
  });
  return {
    handle,
    frames,
    closures,
    order,
    deliveredInsideReadCallback,
    /** Emits one chunk the way a pipe does: synchronously, from its own callback. */
    emitData(text: string): void {
      insideReadCallback = true;
      readable.emit('data', Buffer.from(text));
      insideReadCallback = false;
    },
    emitEnd(): void {
      readable.emit('end');
    },
    emitWriteError(message: string): void {
      writable.emit('error', new Error(message));
    },
  };
}

describe('createStreamPort read delivery', () => {
  it('delivers a frame inside the read callback by default', () => {
    const port = openPort(false);

    port.emitData(PING);

    expect(port.deliveredInsideReadCallback).toEqual([true]);
  });

  it('delivers a deferred frame after the read callback has returned', async () => {
    const port = openPort(true);

    port.emitData(PING);
    expect(port.frames).toEqual([]);
    await nextTurn();

    expect(port.frames).toEqual([{ type: 'ping' }]);
    expect(port.deliveredInsideReadCallback).toEqual([false]);
  });

  it('keeps deferred chunks and the end of the stream in arrival order', async () => {
    const port = openPort(true);

    port.emitData(PING);
    port.emitData(PONG);
    port.emitEnd();
    await nextTurn();

    expect(port.order).toEqual(['ping', 'pong', 'closure:closed']);
  });

  it('drops deferred reads still waiting when the port is closed', async () => {
    const port = openPort(true);

    port.emitData(PING);
    port.handle.port.close(CLOSE_CODES.RELEASED);
    await nextTurn();

    expect(port.frames).toEqual([]);
  });

  it('delivers frames that arrived before a write error ahead of the closure', async () => {
    const port = openPort(true);

    port.emitData(PING);
    port.emitWriteError('write EPIPE');
    await nextTurn();

    expect(port.order).toEqual(['ping', 'closure:closed']);
    expect(port.closures).toEqual([{ kind: 'closed', reason: 'write EPIPE' }]);
  });

  it('delivers frames that arrived before a failure the transport reports ahead of the closure', async () => {
    const port = openPort(true);

    port.emitData(PING);
    port.handle.failed(new Error('kill EPERM'));
    await nextTurn();

    expect(port.order).toEqual(['ping', 'closure:closed']);
    expect(port.closures).toEqual([{ kind: 'closed', reason: 'kill EPERM' }]);
  });

  it('reports a failure from the transport at once on an inline port', () => {
    const port = openPort(false);

    port.handle.failed(new Error('kill EPERM'));

    expect(port.closures).toEqual([{ kind: 'closed', reason: 'kill EPERM' }]);
  });

  it('still delivers the end of the stream after a frame listener throws', () => {
    const immediates = new ManualImmediates();
    try {
      const port = openPort(true);
      port.handle.port.onFrame(() => {
        throw new Error('listener failed');
      });

      port.emitData(PING);
      port.emitEnd();
      const thrown = immediates.runAll();

      expect(thrown.map(String)).toEqual(['Error: listener failed']);
      expect(port.order).toEqual(['ping', 'closure:closed']);
    } finally {
      immediates.restore();
    }
  });
});
