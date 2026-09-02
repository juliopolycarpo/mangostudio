import { beforeEach, describe, expect, it, jest } from 'bun:test';
import {
  decodeTerminalClientMessage,
  encodeTerminalServerMessage,
  TERMINAL_SOCKET_CLOSE_CODES,
} from '@mangostudio/shared/terminal';
import {
  createTerminalSocket,
  type TerminalSocket,
  type TerminalSocketOptions,
  type TerminalSocketStatus,
} from '../../../../src/features/terminal/use-terminal-socket';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../../support/harness/timers';

/**
 * Local to this file, mirroring `realtime-client.test.ts`'s `FakeWebSocket`:
 * `send()` throwing outside OPEN turns a frame sent before `open` into a loud
 * failure, and `drop()` fires a close the way a real transport would.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('InvalidStateError: socket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitServerMessage(message: Parameters<typeof encodeTerminalServerMessage>[0]): void {
    const bytes = encodeTerminalServerMessage(message);
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as MessageEvent);
  }

  drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

function decodedFrames(socket: FakeWebSocket) {
  return socket.sent.map((bytes) => decodeTerminalClientMessage(bytes));
}

describe('createTerminalSocket', () => {
  let statuses: TerminalSocketStatus[] = [];
  let data: Uint8Array[] = [];
  let connectedCount = 0;
  let onUnauthorized: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    statuses = [];
    data = [];
    connectedCount = 0;
    onUnauthorized = jest.fn();
    // A dropped test would otherwise leave a real reconnect timer armed, which
    // can fire mid-way through an unrelated later test and push a stray
    // instance into its (freshly reset) `FakeWebSocket.instances`.
    useFakeTimers();
  });

  function createSocket(overrides: Partial<TerminalSocketOptions> = {}): TerminalSocket {
    return createTerminalSocket({
      sessionId: 'session-1',
      createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      resolveUrl: (sessionId) => `ws://terminal.test/api/terminal/${sessionId}`,
      random: () => 0,
      onUnauthorized,
      onStatusChange: (status) => statuses.push(status),
      onData: (bytes) => data.push(bytes),
      onExit: () => undefined,
      onNotice: () => undefined,
      onConnected: () => {
        connectedCount += 1;
      },
      ...overrides,
    });
  }

  function lastSocket(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error('No socket was created');
    return socket;
  }

  it('resolves the URL from the session id and sets binaryType to arraybuffer', () => {
    createSocket();

    expect(lastSocket().url).toBe('ws://terminal.test/api/terminal/session-1');
    expect(lastSocket().binaryType).toBe('arraybuffer');
  });

  it('reports connecting then open, and fires onConnected before any data', () => {
    createSocket();
    expect(statuses).toEqual(['connecting']);

    lastSocket().open();

    expect(statuses).toEqual(['connecting', 'open']);
    expect(connectedCount).toBe(1);
  });

  it('decodes an incoming data frame and forwards the raw bytes', () => {
    createSocket();
    lastSocket().open();

    lastSocket().emitServerMessage({ type: 'data', data: new TextEncoder().encode('mango\n') });

    expect(data).toHaveLength(1);
    expect(new TextDecoder().decode(data[0])).toBe('mango\n');
  });

  it('sends keystrokes as a framed data message once open', () => {
    const socket = createSocket();
    lastSocket().open();

    socket.send(new TextEncoder().encode('echo mango'));

    const [frame] = decodedFrames(lastSocket());
    expect(frame).toEqual({ type: 'data', data: new TextEncoder().encode('echo mango') });
  });

  it('drops a keystroke sent before the socket is open', () => {
    const socket = createSocket();

    socket.send(new TextEncoder().encode('too early'));

    expect(lastSocket().sent).toHaveLength(0);
  });

  it('splits a paste larger than one client message into several frames', () => {
    const socket = createSocket();
    lastSocket().open();

    const big = new Uint8Array(20_000).fill(97);
    socket.send(big);

    const frames = decodedFrames(lastSocket());
    expect(frames.length).toBeGreaterThan(1);
    const total = frames.reduce(
      (sum, frame) => sum + (frame.type === 'data' ? frame.data.byteLength : 0),
      0
    );
    expect(total).toBe(big.byteLength);
  });

  it('sends a resize frame once open', () => {
    const socket = createSocket();
    lastSocket().open();

    socket.resize(120, 40);

    expect(decodedFrames(lastSocket())).toEqual([{ type: 'resize', cols: 120, rows: 40 }]);
  });

  it('drops a resize below the wire minimum instead of sending an invalid frame', () => {
    const socket = createSocket();
    lastSocket().open();

    socket.resize(0, 0);

    expect(lastSocket().sent).toHaveLength(0);
  });

  it('sends an ack frame with the exact byte count given', () => {
    const socket = createSocket();
    lastSocket().open();

    socket.acknowledge(8192);

    expect(decodedFrames(lastSocket())).toEqual([{ type: 'ack', bytes: 8192 }]);
  });

  it('stops on 4401 and reaches for the auth flow', () => {
    createSocket();
    lastSocket().open();

    lastSocket().drop(TERMINAL_SOCKET_CLOSE_CODES.UNAUTHORIZED);

    expect(statuses.at(-1)).toBe('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt
  });

  it('stops on 4403 without reconnecting', () => {
    createSocket();
    lastSocket().open();

    lastSocket().drop(TERMINAL_SOCKET_CLOSE_CODES.FORBIDDEN);

    expect(statuses.at(-1)).toBe('forbidden');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stops on 4404 without reconnecting', () => {
    createSocket();
    lastSocket().open();

    lastSocket().drop(TERMINAL_SOCKET_CLOSE_CODES.NOT_FOUND);

    expect(statuses.at(-1)).toBe('not-found');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stops on 4409 (replaced) without reconnecting on its own', () => {
    createSocket();
    lastSocket().open();

    lastSocket().drop(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);

    expect(statuses.at(-1)).toBe('replaced');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stops on 4410 (gone) without reconnecting', () => {
    createSocket();
    lastSocket().open();

    lastSocket().drop(TERMINAL_SOCKET_CLOSE_CODES.GONE);

    expect(statuses.at(-1)).toBe('gone');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnect() opens a fresh socket from a stopped status like replaced', () => {
    const socket = createSocket();
    lastSocket().open();
    lastSocket().drop(TERMINAL_SOCKET_CLOSE_CODES.REPLACED);

    socket.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(statuses.at(-1)).toBe('connecting');
  });

  it('reconnects with backoff on an unexpected close', async () => {
    createSocket();
    lastSocket().open();

    lastSocket().drop(1006);

    expect(statuses.at(-1)).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1); // the retry is scheduled, not immediate

    // First failure, zero jitter: base delay 1000ms halved is 500ms.
    await advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('sends a ping every 25s while open and forces a reconnect on a missed pong', async () => {
    createSocket();
    lastSocket().open();

    await advanceTimersByTimeAsync(25_000);
    expect(decodedFrames(lastSocket())).toEqual([{ type: 'ping' }]);

    // No pong arrives before the next tick: the socket is treated as half-open.
    await advanceTimersByTimeAsync(25_000);

    expect(statuses.at(-1)).toBe('reconnecting');
  });

  it('clears the missed-pong watchdog when a pong arrives in time', async () => {
    createSocket();
    lastSocket().open();

    await advanceTimersByTimeAsync(25_000);
    lastSocket().emitServerMessage({ type: 'pong' });
    await advanceTimersByTimeAsync(25_000);

    // A second ping went out and the socket is still open — no reconnect.
    expect(decodedFrames(lastSocket())).toEqual([{ type: 'ping' }, { type: 'ping' }]);
    expect(statuses.at(-1)).toBe('open');
  });

  it('dispose() tears the socket down and fires no further callbacks', () => {
    const socket = createSocket();
    lastSocket().open();

    socket.dispose();
    statuses.length = 0;
    lastSocket().emitServerMessage({ type: 'data', data: new Uint8Array([1]) });

    expect(data).toHaveLength(0);
    expect(statuses).toEqual([]);
  });
});
