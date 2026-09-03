import { describe, expect, it } from 'bun:test';
import {
  TERMINAL_CHUNK_MAX_BYTES,
  TERMINAL_INFLIGHT_WINDOW_BYTES,
  TERMINAL_PENDING_MAX_BYTES,
  TERMINAL_SCROLLBACK_MAX_BYTES,
} from '@mangostudio/shared/terminal';
import type { RuntimeTerminalOutputEvent } from '../../../../src/methods';
import {
  createTerminalSession,
  type TerminalSession,
} from '../../../../src/services/terminal/session';
import { FakePtyPort } from './fake-pty';

function bytesOf(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function decodeFrame(payload: RuntimeTerminalOutputEvent): Uint8Array {
  if (payload.kind !== 'data') throw new Error(`Expected a data frame; received ${payload.kind}.`);
  return Buffer.from(payload.data, 'base64');
}

function totalDataBytes(frames: readonly RuntimeTerminalOutputEvent[]): number {
  return frames
    .filter((frame) => frame.kind === 'data')
    .reduce((sum, frame) => sum + decodeFrame(frame).byteLength, 0);
}

interface Harness {
  readonly session: TerminalSession;
  readonly port: FakePtyPort;
  readonly frames: RuntimeTerminalOutputEvent[];
}

function createHarness(
  overrides: {
    emit?: (payload: RuntimeTerminalOutputEvent, end?: true) => void;
    scrollbackBytes?: number;
  } = {}
): Harness {
  const port = new FakePtyPort();
  const frames: RuntimeTerminalOutputEvent[] = [];
  const emit =
    overrides.emit ??
    ((payload: RuntimeTerminalOutputEvent) => {
      frames.push(payload);
    });

  const session = createTerminalSession({
    sessionId: 'sess-1',
    shell: 'bash',
    cwd: '/home/tester',
    argv: ['bash'],
    env: {},
    cols: 80,
    rows: 24,
    pty: port,
    ...(overrides.scrollbackBytes !== undefined
      ? { scrollbackBytes: overrides.scrollbackBytes }
      : {}),
    emit,
  });
  return { session, port, frames };
}

describe('createTerminalSession', () => {
  it('never emits data while nobody is attached', () => {
    const { session, port, frames } = createHarness();
    port.handles[0]?.emitData(bytesOf(10));

    expect(frames).toHaveLength(0);
    expect(session.pid).toBeGreaterThan(0);
  });

  it('attach replays scrollback and reports the live size', () => {
    const { session, port } = createHarness();
    port.handles[0]?.emitData(new TextEncoder().encode('hello'));

    const result = session.attach();

    expect(Buffer.from(result.scrollback, 'base64').toString('utf8')).toBe('hello');
    expect(result.status).toBe('running');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('scrollback keeps only the last N bytes, silently, once attached later', () => {
    const { session, port } = createHarness();
    const overflow = TERMINAL_SCROLLBACK_MAX_BYTES + 100;
    port.handles[0]?.emitData(bytesOf(overflow, 0x62));

    const result = session.attach();

    expect(Buffer.from(result.scrollback, 'base64').byteLength).toBe(TERMINAL_SCROLLBACK_MAX_BYTES);
  });

  it('honors a smaller scrollbackBytes instead of always using the hard ceiling', () => {
    const { session, port } = createHarness({ scrollbackBytes: 64 });
    port.handles[0]?.emitData(bytesOf(100, 0x63));

    const result = session.attach();

    expect(Buffer.from(result.scrollback, 'base64').byteLength).toBe(64);
  });

  it('clamps a scrollbackBytes above the hard ceiling instead of over-allocating', () => {
    const { session, port } = createHarness({
      scrollbackBytes: TERMINAL_SCROLLBACK_MAX_BYTES + 1000,
    });
    port.handles[0]?.emitData(bytesOf(TERMINAL_SCROLLBACK_MAX_BYTES + 100, 0x64));

    const result = session.attach();

    expect(Buffer.from(result.scrollback, 'base64').byteLength).toBe(TERMINAL_SCROLLBACK_MAX_BYTES);
  });

  it('emits data frames up to the chunk cap once attached', () => {
    const { session, port, frames } = createHarness();
    session.attach();

    port.handles[0]?.emitData(bytesOf(TERMINAL_CHUNK_MAX_BYTES + 10));

    const dataFrames = frames.filter((frame) => frame.kind === 'data');
    expect(dataFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of dataFrames) {
      expect(decodeFrame(frame).byteLength).toBeLessThanOrEqual(TERMINAL_CHUNK_MAX_BYTES);
    }
    expect(totalDataBytes(frames)).toBe(TERMINAL_CHUNK_MAX_BYTES + 10);
  });

  it('stops emission at exactly the in-flight window and an ack resumes it', () => {
    const { session, port, frames } = createHarness();
    session.attach();

    const extra = 1_000;
    port.handles[0]?.emitData(bytesOf(TERMINAL_INFLIGHT_WINDOW_BYTES + extra, 0x63));

    expect(totalDataBytes(frames)).toBe(TERMINAL_INFLIGHT_WINDOW_BYTES);

    session.ack(extra);

    expect(totalDataBytes(frames)).toBe(TERMINAL_INFLIGHT_WINDOW_BYTES + extra);
  });

  it('drops the oldest pending bytes on overflow and emits one dropped marker when draining resumes', () => {
    const { session, port, frames } = createHarness();
    session.attach();

    // Fill the in-flight window exactly. Emitted immediately: nothing was
    // queued yet, so this round drains in full.
    port.handles[0]?.emitData(bytesOf(TERMINAL_INFLIGHT_WINDOW_BYTES, 0x63));
    expect(totalDataBytes(frames)).toBe(TERMINAL_INFLIGHT_WINDOW_BYTES);

    // The window is now fully used, so none of this can drain: it queues in
    // the pending ring and then overflows it, across two separate chunks —
    // proving the drop is counted, not reported, while draining is blocked.
    const overflowBy = 5_000;
    port.handles[0]?.emitData(bytesOf(TERMINAL_PENDING_MAX_BYTES / 2, 0x64));
    port.handles[0]?.emitData(bytesOf(TERMINAL_PENDING_MAX_BYTES / 2 + overflowBy, 0x64));

    expect(totalDataBytes(frames)).toBe(TERMINAL_INFLIGHT_WINDOW_BYTES);
    expect(frames.some((frame) => frame.kind === 'dropped')).toBe(false);

    // Acking opens the window: draining resumes with exactly one dropped
    // marker for the whole episode — not one per chunk that overflowed —
    // and real data frames continue after it.
    session.ack(TERMINAL_INFLIGHT_WINDOW_BYTES);

    const droppedFrames = frames.filter((frame) => frame.kind === 'dropped');
    expect(droppedFrames).toHaveLength(1);
    expect(droppedFrames[0]).toMatchObject({ kind: 'dropped', bytes: overflowBy });
    expect(totalDataBytes(frames)).toBeGreaterThan(TERMINAL_INFLIGHT_WINDOW_BYTES);
  });

  it('exit while attached flushes pending and emits exit with end:true exactly once', () => {
    const { session, port, frames } = createHarness();
    session.attach();
    port.handles[0]?.emitData(new TextEncoder().encode('bye'));

    port.handles[0]?.emitExit(0, null);

    const exitFrames = frames.filter((frame) => frame.kind === 'exit');
    expect(exitFrames).toEqual([{ kind: 'exit', exitCode: 0, signal: null }]);
  });

  it('exit is the last frame ever sent, even with pending leftover and a trailing ack', () => {
    const { session, port, frames } = createHarness();
    session.attach();

    // Fill the window so pending still holds bytes when the shell exits.
    port.handles[0]?.emitData(bytesOf(TERMINAL_INFLIGHT_WINDOW_BYTES, 0x65));
    port.handles[0]?.emitData(bytesOf(1_000, 0x66));

    port.handles[0]?.emitExit(0, null);
    expect(frames.at(-1)).toEqual({ kind: 'exit', exitCode: 0, signal: null });

    // A trailing ack for the bytes the viewer already consumed must not
    // reopen a stream `emit` has already ended with `end: true`.
    session.ack(TERMINAL_INFLIGHT_WINDOW_BYTES);

    expect(frames.filter((frame) => frame.kind === 'exit')).toHaveLength(1);
    expect(frames.at(-1)).toEqual({ kind: 'exit', exitCode: 0, signal: null });
  });

  it('names the pending output the exit throws away instead of truncating in silence', () => {
    const { session, port, frames } = createHarness();
    session.attach();

    // Fill the window so the last 1 000 bytes are still parked when it exits.
    port.handles[0]?.emitData(bytesOf(TERMINAL_INFLIGHT_WINDOW_BYTES, 0x65));
    port.handles[0]?.emitData(bytesOf(1_000, 0x66));

    port.handles[0]?.emitExit(0, null);

    expect(frames.at(-2)).toEqual({ kind: 'dropped', bytes: 1_000 });
    expect(frames.at(-1)).toEqual({ kind: 'exit', exitCode: 0, signal: null });
  });

  it('raises no dropped marker when the exit had nothing left to flush', () => {
    const { session, port, frames } = createHarness();
    session.attach();
    port.handles[0]?.emitData(new TextEncoder().encode('bye'));

    port.handles[0]?.emitExit(0, null);

    expect(frames.filter((frame) => frame.kind === 'dropped')).toHaveLength(0);
  });

  it('exit while detached is reported by the next attach, not by a stream frame', () => {
    const { session, port, frames } = createHarness();
    port.handles[0]?.emitExit(1, 'SIGKILL');

    expect(frames.filter((frame) => frame.kind === 'exit')).toHaveLength(0);

    const result = session.attach();
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe('SIGKILL');
  });

  it('refuses a write once the session has exited', () => {
    const { session, port } = createHarness();
    port.handles[0]?.emitExit(0, null);

    expect(() => session.write(Buffer.from('hi').toString('base64'))).toThrow(/already exited/);
  });

  it('write decodes base64 and forwards raw bytes to the pty', () => {
    const { session, port } = createHarness();
    session.write(Buffer.from('echo hi\n').toString('base64'));

    expect(port.handles[0]?.writes[0]).toEqual(new TextEncoder().encode('echo hi\n'));
  });

  it('resize validates bounds and forwards a valid size to the pty', () => {
    const { session, port } = createHarness();

    expect(() => session.resize(0, 24)).toThrow(/cols must be an integer/);
    expect(() => session.resize(80, 0)).toThrow(/rows must be an integer/);

    session.resize(100, 40);
    expect(port.handles[0]?.resizes).toEqual([{ cols: 100, rows: 40 }]);
    expect(session.snapshot().cols).toBe(100);
    expect(session.snapshot().rows).toBe(40);
  });

  it('close kills the underlying pty', () => {
    const { session, port } = createHarness();
    session.close();
    expect(port.handles[0]?.closeCalls).toBe(1);
  });

  it('detach stops emission and clears whatever was queued', () => {
    const { session, port, frames } = createHarness();
    session.attach();
    session.detach();

    port.handles[0]?.emitData(bytesOf(10));

    expect(frames).toHaveLength(0);
    expect(session.snapshot().attached).toBe(false);
  });

  it('an emit that throws is swallowed and treated as the viewer going away', () => {
    const { session, port, frames } = createHarness();
    session.attach();

    const throwingHarness = createHarness({
      emit: () => {
        throw new Error('port closed');
      },
    });
    throwingHarness.session.attach();

    // The throw must not escape the pty's data callback.
    expect(() => throwingHarness.port.handles[0]?.emitData(bytesOf(10))).not.toThrow();
    expect(throwingHarness.session.snapshot().attached).toBe(false);

    // Unrelated session keeps working: the fake used for the assertion above
    // is isolated from this one.
    port.handles[0]?.emitData(bytesOf(10));
    expect(totalDataBytes(frames)).toBe(10);
  });

  it('lists a snapshot shaped for terminal.list', () => {
    const { session } = createHarness();
    expect(session.snapshot()).toMatchObject({
      sessionId: 'sess-1',
      shell: 'bash',
      cwd: '/home/tester',
      cols: 80,
      rows: 24,
      status: 'running',
      exitCode: null,
      signal: null,
      attached: false,
    });
  });
});
