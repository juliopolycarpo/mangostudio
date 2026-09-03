/**
 * Terminal socket: one `WebSocket` per attached session, driving the binary
 * codec in `@mangostudio/shared/terminal`.
 *
 * Split like `realtime-client.ts` into a plain factory (`createTerminalSocket`,
 * the seam a `FakeWebSocket` test drives directly) and a thin hook
 * (`useTerminalSocket`) that owns the instance's lifecycle. Unlike the realtime
 * client this is not a shared, ref-counted singleton — one hook call is one
 * session's socket, torn down whenever `sessionId` changes or the caller
 * unmounts.
 *
 * Deliberately unaware of xterm: `onData` hands the caller raw bytes, and
 * `acknowledge` sends whatever byte count the caller passes. Coalescing acks
 * into fewer frames is `ack-accounting.ts`'s job, wired up one layer above by
 * `TerminalView`.
 */

import {
  chunkTerminalBytes,
  decodeTerminalServerMessage,
  encodeTerminalClientMessage,
  TERMINAL_CLIENT_MESSAGE_MAX_BYTES,
  TERMINAL_COLS_MIN,
  TERMINAL_ROWS_MIN,
  TERMINAL_SOCKET_CLOSE_CODES,
  TERMINAL_SOCKET_PATH,
  type TerminalExit,
  type TerminalNotice,
} from '@mangostudio/shared/terminal';
import { useEffect, useRef, useState } from 'react';
import { getWebSocketBaseUrl } from '@/lib/api-base-url';
import { scheduleLoginRedirect } from '@/lib/auth-navigate';
import { nextReconnectDelay } from '@/lib/realtime/reconnect-backoff';

const PING_MS = 25_000;

/**
 * `open` is the only phase a frame may be sent in. The rest are terminal for
 * this socket instance — `reconnect()` is the only way out of any of them,
 * and only `replaced`/`forbidden`/`not-found`/`gone`/`unauthorized` are ones a
 * server close code puts the socket into on purpose.
 */
export type TerminalSocketStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'replaced'
  | 'forbidden'
  | 'not-found'
  | 'gone'
  | 'unauthorized';

interface TerminalSocketCallbacks {
  readonly onData: (bytes: Uint8Array) => void;
  readonly onExit: (exit: TerminalExit) => void;
  readonly onNotice: (notice: TerminalNotice) => void;
  readonly onStatusChange: (status: TerminalSocketStatus) => void;
  /**
   * Fires once the transport is open, before any scrollback replay arrives.
   * The caller's cue to clear its screen (`term.reset()`) so a reconnect does
   * not show the replayed scrollback appended after whatever was already there.
   */
  readonly onConnected: () => void;
}

export interface TerminalSocketOptions extends TerminalSocketCallbacks {
  readonly sessionId: string;
  /** Socket factory — the seam unit tests use to drive the protocol. */
  readonly createSocket?: (url: string) => WebSocket;
  readonly resolveUrl?: (sessionId: string) => string;
  /** Jitter source, injectable so the backoff schedule is assertable. */
  readonly random?: () => number;
  /** Called once when the server rejects the session with `4401`. */
  readonly onUnauthorized?: () => void;
}

export interface TerminalSocket {
  /** Raw bytes from the user (a keystroke or a paste); chunked and framed as `data`. */
  send(bytes: Uint8Array): void;
  /** Sent after every fit; ignored below the wire's minimum size. */
  resize(cols: number, rows: number): void;
  /** Bytes the caller has flushed to the terminal since its last ack. */
  acknowledge(bytes: number): void;
  /** Forces a fresh connection, even from a stopped status like `replaced`. */
  reconnect(): void;
  /** Tears the socket down. No callback fires again after this returns. */
  dispose(): void;
}

function defaultResolveUrl(sessionId: string): string {
  return `${getWebSocketBaseUrl()}${TERMINAL_SOCKET_PATH}/${encodeURIComponent(sessionId)}`;
}

/**
 * Creates one terminal socket. Plain (no React), so a `FakeWebSocket` test can
 * drive the protocol directly — see `use-terminal-socket.test.ts`.
 *
 * @example
 * const socket = createTerminalSocket({
 *   sessionId, onData, onExit, onNotice, onConnected, onStatusChange,
 * });
 * socket.send(new TextEncoder().encode('ls\n'));
 */
export function createTerminalSocket(options: TerminalSocketOptions): TerminalSocket {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const resolveUrl = options.resolveUrl ?? defaultResolveUrl;
  const random = options.random ?? Math.random;
  const onUnauthorized = options.onUnauthorized ?? scheduleLoginRedirect;

  let disposed = false;
  let status: TerminalSocketStatus = 'connecting';
  let socket: WebSocket | null = null;
  let failureCount = 0;
  let awaitingPong = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Last size actually put on the wire, to skip resends of an unchanged grid.
   * Cleared on every `connect()`: the hub never tells the browser the PTY's
   * size, so after a reconnect or a takeover the size must be resent even when
   * it matches what this client last sent.
   */
  let lastSentSize: { cols: number; rows: number } | null = null;

  function setStatus(next: TerminalSocketStatus): void {
    status = next;
    options.onStatusChange(next);
  }

  function stopPing(): void {
    if (pingTimer === undefined) return;
    clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === undefined) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function closeSocket(): void {
    const current = socket;
    socket = null;
    stopPing();
    try {
      current?.close();
    } catch {
      // Closing an already-closing socket is not actionable.
    }
  }

  function sendFrame(bytes: Uint8Array): boolean {
    if (status !== 'open' || !socket) return false;
    try {
      // Every frame here comes from `new Uint8Array(n)` or `TextEncoder`
      // output, never a `SharedArrayBuffer` view; the cast narrows to the one
      // overload `WebSocket.send` actually declares for a typed array.
      socket.send(bytes as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  function onPingTick(): void {
    if (status !== 'open') return;
    if (awaitingPong) {
      // A missed pong means the socket is half-open (laptop sleep, a dead NAT
      // binding). Nothing else will ever fire `onclose` here, so force it.
      closeSocket();
      scheduleReconnect();
      return;
    }
    if (sendFrame(encodeTerminalClientMessage({ type: 'ping' }))) awaitingPong = true;
  }

  function scheduleReconnect(): void {
    if (disposed) return;
    failureCount += 1;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined;
        connect();
      },
      nextReconnectDelay(failureCount, random)
    );
  }

  function handleClose(code: number): void {
    stopPing();
    awaitingPong = false;
    const codes = TERMINAL_SOCKET_CLOSE_CODES;
    switch (code) {
      case codes.UNAUTHORIZED:
        setStatus('unauthorized');
        onUnauthorized();
        return;
      case codes.FORBIDDEN:
        // Reconnecting would replay the identical rejection.
        setStatus('forbidden');
        return;
      case codes.NOT_FOUND:
        setStatus('not-found');
        return;
      case codes.REPLACED:
        // Another window holds the session now. Only the user's own
        // "Bring it here" action (`reconnect()`) may retry this.
        setStatus('replaced');
        return;
      case codes.GONE:
        // The session ended; the exit line renders from the last `exit`
        // frame or a session refetch, not from this socket reopening.
        setStatus('gone');
        return;
      default:
        scheduleReconnect();
    }
  }

  function handleMessage(data: ArrayBuffer): void {
    awaitingPong = false;
    // A frame this build cannot decode — a newer hub's frame type, a truncated
    // body — is one frame's worth of output, not a reason to throw out of the
    // socket's `onmessage` and take the page's error handler with it. The
    // session keeps streaming; the browser smoke asserts on an empty
    // `pageerror` list and would fail on the alternative.
    let message: ReturnType<typeof decodeTerminalServerMessage>;
    try {
      message = decodeTerminalServerMessage(new Uint8Array(data));
    } catch {
      return;
    }
    switch (message.type) {
      case 'data':
        options.onData(message.data);
        return;
      case 'exit':
        options.onExit(message.exit);
        return;
      case 'notice':
        options.onNotice(message.notice);
        return;
      case 'pong':
        return;
    }
  }

  function connect(): void {
    if (disposed) return;
    setStatus(failureCount > 0 ? 'reconnecting' : 'connecting');
    awaitingPong = false;
    lastSentSize = null;

    let created: WebSocket;
    try {
      created = createSocket(resolveUrl(options.sessionId));
    } catch {
      // A constructor throw (unusable URL, blocked scheme) is a connect failure.
      scheduleReconnect();
      return;
    }
    created.binaryType = 'arraybuffer';
    socket = created;

    created.onopen = () => {
      if (socket !== created) return;
      failureCount = 0;
      setStatus('open');
      options.onConnected();
      stopPing();
      pingTimer = setInterval(onPingTick, PING_MS);
    };
    created.onmessage = (event: MessageEvent) => {
      if (socket !== created) return;
      handleMessage(event.data as ArrayBuffer);
    };
    created.onclose = (event: CloseEvent) => {
      if (socket !== created) return;
      socket = null;
      handleClose(event.code);
    };
  }

  connect();

  return {
    send(bytes: Uint8Array): void {
      for (const chunk of chunkTerminalBytes(bytes, TERMINAL_CLIENT_MESSAGE_MAX_BYTES - 1)) {
        if (!sendFrame(encodeTerminalClientMessage({ type: 'data', data: chunk }))) return;
      }
    },
    resize(cols: number, rows: number): void {
      if (cols < TERMINAL_COLS_MIN || rows < TERMINAL_ROWS_MIN) return;
      // A `ResizeObserver` fires per animation frame during a drag, but the cell
      // grid usually does not change; each redundant frame costs a schema check
      // and an awaited `terminal.resize` RPC on the socket's serialized message
      // chain, which head-of-line-blocks keystrokes for the whole drag.
      if (lastSentSize?.cols === cols && lastSentSize.rows === rows) return;
      if (!sendFrame(encodeTerminalClientMessage({ type: 'resize', cols, rows }))) return;
      lastSentSize = { cols, rows };
    },
    acknowledge(bytes: number): void {
      sendFrame(encodeTerminalClientMessage({ type: 'ack', bytes }));
    },
    reconnect(): void {
      clearReconnectTimer();
      closeSocket();
      failureCount = 0;
      connect();
    },
    dispose(): void {
      disposed = true;
      clearReconnectTimer();
      closeSocket();
    },
  };
}

/**
 * Everything `createTerminalSocket` takes except the status sink, which the
 * hook owns: it reports status as React state instead.
 */
export type UseTerminalSocketOptions = Omit<TerminalSocketOptions, 'onStatusChange'>;

export interface UseTerminalSocketResult {
  readonly status: TerminalSocketStatus;
  send(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  acknowledge(bytes: number): void;
  reconnect(): void;
}

/**
 * Owns one terminal socket for the lifetime of `sessionId`.
 *
 * @example
 * const socket = useTerminalSocket({
 *   sessionId, onData, onExit, onNotice, onConnected,
 * });
 * socket.send(new TextEncoder().encode(keystroke));
 */
export function useTerminalSocket(options: UseTerminalSocketOptions): UseTerminalSocketResult {
  const { sessionId } = options;
  const [status, setStatus] = useState<TerminalSocketStatus>('connecting');
  const socketRef = useRef<TerminalSocket | null>(null);

  // Read through refs so the effect below depends on `sessionId` alone: an
  // inline callback identity changing on every render must not tear down and
  // reopen the socket underneath the terminal it is streaming into.
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  useEffect(() => {
    const socket = createTerminalSocket({
      sessionId,
      createSocket: callbacksRef.current.createSocket,
      resolveUrl: callbacksRef.current.resolveUrl,
      random: callbacksRef.current.random,
      onUnauthorized: callbacksRef.current.onUnauthorized,
      onStatusChange: setStatus,
      onData: (bytes) => callbacksRef.current.onData(bytes),
      onExit: (exit) => callbacksRef.current.onExit(exit),
      onNotice: (notice) => callbacksRef.current.onNotice(notice),
      onConnected: () => callbacksRef.current.onConnected(),
    });
    socketRef.current = socket;
    return () => {
      socket.dispose();
      socketRef.current = null;
    };
  }, [sessionId]);

  return {
    status,
    send: (bytes) => socketRef.current?.send(bytes),
    resize: (cols, rows) => socketRef.current?.resize(cols, rows),
    acknowledge: (bytes) => socketRef.current?.acknowledge(bytes),
    reconnect: () => socketRef.current?.reconnect(),
  };
}
