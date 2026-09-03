/**
 * One live terminal session: a PTY, its scrollback, and the credit-gated
 * stream that keeps a slow or absent viewer from turning a chatty shell into
 * unbounded memory.
 *
 * Emission is credit-gated because the transport has no backpressure signal
 * of its own — `Bun.Terminal` cannot be told to stop reading the child, and
 * the hub's socket has a queue but no way to ask this runtime to pause. So
 * the runtime tracks `inflight` (bytes sent and not yet acknowledged) itself
 * and refuses to push more once it reaches `TERMINAL_INFLIGHT_WINDOW_BYTES`;
 * `terminal.ack` is what lowers it again. Whatever cannot go out yet waits in
 * a bounded pending ring, and whatever cannot even fit in *that* is dropped —
 * oldest first — with the loss counted rather than silently eaten, so the
 * next `dropped` marker tells the viewer a gap happened instead of leaving a
 * silently truncated scrollback.
 */

import type { RuntimeShellKind } from '@mangostudio/shared/runtime-protocol';
import {
  TERMINAL_CHUNK_MAX_BYTES,
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_INFLIGHT_WINDOW_BYTES,
  TERMINAL_PENDING_MAX_BYTES,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
  TERMINAL_SCROLLBACK_MAX_BYTES,
} from '@mangostudio/shared/terminal';
import { RuntimeToolArgumentError } from '../../errors';
import type {
  RuntimeTerminalAttachResult,
  RuntimeTerminalOutputEvent,
  RuntimeTerminalSessionStatus,
  RuntimeTerminalSessionSummary,
} from '../../methods';
import { ByteRingBuffer } from './buffer';
import { TerminalExitedError } from './errors';
import type { PtyPort } from './pty';

export interface TerminalSession {
  readonly sessionId: string;
  readonly pid: number;
  readonly shell: RuntimeShellKind;
  readonly cwd: string;
  attach(): RuntimeTerminalAttachResult;
  detach(): void;
  write(dataBase64: string): void;
  resize(cols: number, rows: number): void;
  ack(bytes: number): void;
  /** Kills the underlying PTY. Idempotent. */
  close(): void;
  snapshot(): RuntimeTerminalSessionSummary;
}

export interface CreateTerminalSessionOptions {
  readonly sessionId: string;
  readonly shell: RuntimeShellKind;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly pty: PtyPort;
  /** Omitted: `TERMINAL_SCROLLBACK_MAX_BYTES`, which is also the hard ceiling this is clamped to. */
  readonly scrollbackBytes?: number;
  /**
   * Publishes one output frame for this session. May throw — `port.send` on
   * a closed hub connection does — and every call site here treats a throw
   * as "the viewer is gone" rather than letting it escape into the PTY's own
   * data callback.
   */
  readonly emit: (payload: RuntimeTerminalOutputEvent, end?: true) => void;
}

/**
 * Rejects a size the wire schema would not accept, so `terminal.open` and
 * `terminal.resize` refuse the same values. Only the hub validates the request
 * body, and a runtime is not entitled to assume the peer on the other end of
 * the socket is one — a `cols: 0` reaching `Bun.spawn` is a PTY nobody can
 * render into rather than an error anyone can read.
 *
 * // Usage: assertTerminalSize(80, 24)
 */
function assertTerminalSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < TERMINAL_COLS_MIN || cols > TERMINAL_COLS_MAX) {
    throw new RuntimeToolArgumentError(
      `Terminal cols must be an integer between ${TERMINAL_COLS_MIN} and ${TERMINAL_COLS_MAX}; received ${cols}.`
    );
  }
  if (!Number.isInteger(rows) || rows < TERMINAL_ROWS_MIN || rows > TERMINAL_ROWS_MAX) {
    throw new RuntimeToolArgumentError(
      `Terminal rows must be an integer between ${TERMINAL_ROWS_MIN} and ${TERMINAL_ROWS_MAX}; received ${rows}.`
    );
  }
}

/** Spawns the PTY and returns the session that owns it. */
export function createTerminalSession(options: CreateTerminalSessionOptions): TerminalSession {
  assertTerminalSize(options.cols, options.rows);
  const scrollback = new ByteRingBuffer(
    Math.min(
      options.scrollbackBytes ?? TERMINAL_SCROLLBACK_MAX_BYTES,
      TERMINAL_SCROLLBACK_MAX_BYTES
    )
  );
  const pending = new ByteRingBuffer(TERMINAL_PENDING_MAX_BYTES);
  let cols = options.cols;
  let rows = options.rows;
  let attached = false;
  let inflight = 0;
  let status: RuntimeTerminalSessionStatus = 'running';
  let exit: { exitCode: number | null; signal: string | null } | null = null;

  const safeEmit = (payload: RuntimeTerminalOutputEvent, end?: true): boolean => {
    try {
      options.emit(payload, end);
      return true;
    } catch {
      // The hub's socket closed under us. Nobody is listening, so stop
      // pretending there is: further pushes would just throw again, and
      // whatever is still parked has no destination.
      attached = false;
      pending.clear();
      return false;
    }
  };

  /** Flushes as much of `pending` as the in-flight window allows. */
  const drain = (): void => {
    if (inflight >= TERMINAL_INFLIGHT_WINDOW_BYTES || pending.byteLength === 0) return;

    const dropped = pending.takeDroppedBytes();
    if (dropped > 0 && !safeEmit({ kind: 'dropped', bytes: dropped })) return;

    while (inflight < TERMINAL_INFLIGHT_WINDOW_BYTES && pending.byteLength > 0) {
      const room = TERMINAL_INFLIGHT_WINDOW_BYTES - inflight;
      const size = Math.min(TERMINAL_CHUNK_MAX_BYTES, room, pending.byteLength);
      const chunk = pending.take(size);
      inflight += chunk.byteLength;
      if (!safeEmit({ kind: 'data', data: Buffer.from(chunk).toString('base64') })) return;
    }
  };

  const tryEmit = (): void => {
    if (!attached) return;
    drain();
  };

  const handle = options.pty.spawn({
    argv: options.argv,
    cwd: options.cwd,
    env: options.env,
    cols,
    rows,
    onData: (chunk) => {
      scrollback.push(chunk);
      if (status === 'exited') return;
      pending.push(chunk);
      tryEmit();
    },
    onExit: (exitCode, signal) => {
      status = 'exited';
      exit = { exitCode, signal };
      if (!attached) return;
      // Flush whatever the window still allows before ending the stream —
      // the exit frame is the only one carrying `end: true`, so it must be
      // the last thing sent regardless of how much pending output survives.
      drain();
      // Whatever the window would not let through dies with the stream. Say
      // so: silently truncating the tail of a command's output reads to the
      // viewer as the command having printed less than it did, which is the
      // one thing the `dropped` marker exists to prevent.
      const lost = pending.byteLength + pending.takeDroppedBytes();
      if (lost > 0 && attached) safeEmit({ kind: 'dropped', bytes: lost });
      if (attached) safeEmit({ kind: 'exit', exitCode, signal }, true);
      // The exit frame is the last one this stream may ever carry — `emit`
      // dropped its sequence counter for it, so anything sent afterwards
      // would look like a new stream starting over at seq 0. A trailing
      // `terminal.ack` for the last bytes a viewer consumed must not reopen
      // it, so nothing more may drain once the stream has ended.
      attached = false;
      pending.clear();
    },
  });

  return {
    sessionId: options.sessionId,
    pid: handle.pid,
    shell: options.shell,
    cwd: options.cwd,

    attach() {
      pending.clear();
      attached = true;
      // The replay is bytes this runtime hands the viewer, so it is charged to
      // the window like any other output. Zeroing here instead would credit the
      // window twice: the viewer cannot tell replayed bytes from live ones, so
      // it acks both, and every scrollback byte would then buy a live byte that
      // was never accounted for.
      const replay = scrollback.snapshot();
      inflight = replay.byteLength;
      return {
        sessionId: options.sessionId,
        scrollback: Buffer.from(replay).toString('base64'),
        status,
        exitCode: exit?.exitCode ?? null,
        signal: exit?.signal ?? null,
        cols,
        rows,
      };
    },

    detach() {
      attached = false;
      pending.clear();
    },

    write(dataBase64) {
      if (status === 'exited') throw new TerminalExitedError(options.sessionId);
      handle.write(Buffer.from(dataBase64, 'base64'));
    },

    resize(nextCols, nextRows) {
      assertTerminalSize(nextCols, nextRows);
      cols = nextCols;
      rows = nextRows;
      handle.resize(cols, rows);
    },

    ack(bytes) {
      if (!Number.isInteger(bytes) || bytes < 0) {
        throw new RuntimeToolArgumentError(
          `Terminal ack bytes must be a non-negative integer; received ${bytes}.`
        );
      }
      inflight = Math.max(0, inflight - bytes);
      tryEmit();
    },

    close() {
      handle.close();
    },

    snapshot() {
      return {
        sessionId: options.sessionId,
        shell: options.shell,
        cwd: options.cwd,
        cols,
        rows,
        status,
        exitCode: exit?.exitCode ?? null,
        signal: exit?.signal ?? null,
        attached,
        pid: handle.pid,
      };
    },
  };
}
