import { REALTIME_CLOSE_CODES } from '@mangostudio/shared/realtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindRealtimeClientToUser,
  createRealtimeClient,
  getRealtimeClient,
  type RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeSignal,
  type RealtimeTopicListener,
  resetRealtimeClient,
} from '@/lib/realtime/realtime-client';

/** Heartbeat cadence: the idle timeout (60 s) divided by 2.5. */
const HEARTBEAT_MS = 24_000;
const LINGER_MS = 5_000;
const STABILITY_MS = 10_000;

/**
 * Local to this file per the testing guide — nothing else needs a socket double.
 *
 * `send()` throwing outside OPEN is load-bearing: it turns "no frame before
 * `ready`" from a silent pass into a loud failure. `close()` deliberately does
 * *not* fire `onclose`, so a test can fire a stale one by hand and prove the
 * socket-identity guard.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('InvalidStateError: socket is not open');
    }
    this.sent.push(data);
  }

  /**
   * Opt-in: real transports fire `onclose` from `close()`. Off by default so the
   * common case can fire a *stale* close by hand; on, it proves the client nulls
   * its socket reference before closing.
   */
  closeFiresOnclose = false;

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith ??= code;
    if (this.closeFiresOnclose) this.onclose?.({ code } as CloseEvent);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emit(message: unknown): void {
    this.emitRaw(JSON.stringify(message));
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('createRealtimeClient', () => {
  let onUnauthorized = vi.fn();

  beforeEach(() => {
    FakeWebSocket.instances = [];
    onUnauthorized = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createClient(overrides: Partial<RealtimeClientOptions> = {}): RealtimeClient {
    return createRealtimeClient({
      createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      resolveUrl: () => 'ws://realtime.test/api/ws',
      onUnauthorized,
      // Zero jitter makes the half-jitter backoff schedule exactly assertable.
      random: () => 0,
      ...overrides,
    });
  }

  function socketAt(index: number): FakeWebSocket {
    const socket = FakeWebSocket.instances[index];
    if (!socket) throw new Error(`No socket at index ${index}`);
    return socket;
  }

  function lastSocket(): FakeWebSocket {
    return socketAt(FakeWebSocket.instances.length - 1);
  }

  function frames(socket: FakeWebSocket): unknown[] {
    return socket.sent.map((raw) => JSON.parse(raw));
  }

  /** Brings the newest socket to the `ready` phase and returns it. */
  function makeReady(): FakeWebSocket {
    const socket = lastSocket();
    socket.open();
    socket.emit({ type: 'ready' });
    return socket;
  }

  function collect(): { listener: RealtimeTopicListener; signals: RealtimeSignal[] } {
    const signals: RealtimeSignal[] = [];
    return {
      signals,
      listener: (signal) => {
        signals.push(signal);
      },
    };
  }

  it('opens no socket until the first subscribe', () => {
    createClient();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('shares one socket across listeners and topics', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    client.subscribe('settings', () => undefined);
    client.subscribe('git:chat-1', () => undefined);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socketAt(0).url).toBe('ws://realtime.test/api/ws');
  });

  it('sends nothing before ready, even once the transport is open', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    vi.advanceTimersByTime(0);
    expect(socketAt(0).sent).toHaveLength(0);

    socketAt(0).open();
    vi.advanceTimersByTime(0);
    expect(socketAt(0).sent).toHaveLength(0);

    socketAt(0).emit({ type: 'ready' });
    expect(frames(socketAt(0))).toEqual([{ type: 'subscribe', topics: ['settings'] }]);
  });

  it('batches every pending topic into a single subscribe frame on ready', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    client.subscribe('git:chat-1', () => undefined);
    client.subscribe('git:chat-2', () => undefined);

    const socket = makeReady();
    expect(frames(socket)).toEqual([
      { type: 'subscribe', topics: ['settings', 'git:chat-1', 'git:chat-2'] },
    ]);
  });

  it('chunks 33 topics into frames of 32 and 1', () => {
    const client = createClient();
    const topics = Array.from({ length: 33 }, (_unused, index) => `git:chat-${index}`);
    for (const topic of topics) client.subscribe(topic, () => undefined);

    const socket = makeReady();
    expect(frames(socket)).toEqual([
      { type: 'subscribe', topics: topics.slice(0, 32) },
      { type: 'subscribe', topics: topics.slice(32) },
    ]);
  });

  it('coalesces same-tick adds into one subscribe frame', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();

    client.subscribe('git:chat-1', () => undefined);
    client.subscribe('git:chat-2', () => undefined);
    vi.advanceTimersByTime(0);

    expect(frames(socket)).toEqual([
      { type: 'subscribe', topics: ['settings'] },
      { type: 'subscribe', topics: ['git:chat-1', 'git:chat-2'] },
    ]);
  });

  it('costs no frames and no socket churn for StrictMode subscribe/unsubscribe/subscribe', () => {
    const client = createClient();
    const release = client.subscribe('settings', () => undefined);
    release();
    client.subscribe('settings', () => undefined);

    const socket = makeReady();
    vi.advanceTimersByTime(LINGER_MS);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(frames(socket)).toEqual([{ type: 'subscribe', topics: ['settings'] }]);
    expect(socket.closedWith).toBeUndefined();
  });

  it('delivers subscribed and invalidate only to the matching topic', () => {
    const client = createClient();
    const settings = collect();
    const git = collect();
    client.subscribe('settings', settings.listener);
    client.subscribe('git:chat-1', git.listener);

    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['settings', 'git:chat-1'] });
    socket.emit({ type: 'invalidate', topic: 'settings', scopes: ['provider'] });
    socket.emit({ type: 'invalidate', topic: 'git:chat-9' });

    expect(settings.signals).toEqual([
      { type: 'subscribed' },
      {
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings', scopes: ['provider'] },
      },
    ]);
    expect(git.signals).toEqual([{ type: 'subscribed' }]);
  });

  it('fans a signal out to every listener on the topic', () => {
    const client = createClient();
    const first = collect();
    const second = collect();
    client.subscribe('settings', first.listener);
    client.subscribe('settings', second.listener);

    makeReady().emit({ type: 'subscribed', topics: ['settings'] });

    expect(first.signals).toHaveLength(1);
    expect(second.signals).toHaveLength(1);
  });

  it('ignores malformed frames and keeps the socket alive', () => {
    const client = createClient();
    const settings = collect();
    client.subscribe('settings', settings.listener);
    const socket = makeReady();

    socket.emitRaw('not json at all');
    socket.emitRaw(42);
    socket.emitRaw(undefined);
    socket.emit(null);
    socket.emit([{ type: 'subscribed', topics: ['settings'] }]);
    socket.emit({ type: 'welcome' });
    socket.emit({ type: 'subscribed', topics: [] });
    socket.emit({ type: 'invalidate' });

    expect(settings.signals).toEqual([]);
    expect(socket.closedWith).toBeUndefined();

    socket.emit({ type: 'subscribed', topics: ['settings'] });
    expect(settings.signals).toEqual([{ type: 'subscribed' }]);
  });

  it('contains a throwing listener', () => {
    const client = createClient();
    const healthy = collect();
    client.subscribe('settings', () => {
      throw new Error('listener exploded');
    });
    client.subscribe('settings', healthy.listener);

    const socket = makeReady();
    expect(() => socket.emit({ type: 'subscribed', topics: ['settings'] })).not.toThrow();
    expect(healthy.signals).toHaveLength(1);
    expect(socket.closedWith).toBeUndefined();
  });

  it('contains a listener that returns a rejected promise', async () => {
    const client = createClient();
    const healthy = collect();
    client.subscribe('settings', () => Promise.reject(new Error('async listener failed')));
    client.subscribe('settings', healthy.listener);

    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['settings'] });
    // Settle the rejection: an unhandled one would fail the suite.
    await Promise.resolve();

    expect(healthy.signals).toHaveLength(1);
    expect(socket.closedWith).toBeUndefined();
  });

  it('allows a listener to unsubscribe during dispatch', () => {
    const client = createClient();
    const second = collect();
    let release: () => void = () => undefined;
    const selfReleasing = vi.fn(() => {
      release();
    });
    release = client.subscribe('settings', selfReleasing);
    client.subscribe('settings', second.listener);

    const socket = makeReady();
    expect(() => socket.emit({ type: 'subscribed', topics: ['settings'] })).not.toThrow();
    expect(selfReleasing).toHaveBeenCalledOnce();
    expect(second.signals).toHaveLength(1);

    socket.emit({ type: 'subscribed', topics: ['settings'] });
    expect(selfReleasing).toHaveBeenCalledOnce();
    expect(second.signals).toHaveLength(2);
  });

  it('dispatches to a snapshot when one listener releases another', () => {
    const client = createClient();
    const second = collect();
    let releaseSecond: () => void = () => undefined;
    const first = vi.fn(() => {
      releaseSecond();
    });
    client.subscribe('settings', first);
    releaseSecond = client.subscribe('settings', second.listener);

    const socket = makeReady();
    // The dispatch runs against the set as it was when the frame arrived, so the
    // released listener is not skipped mid-loop.
    socket.emit({ type: 'subscribed', topics: ['settings'] });
    expect(second.signals).toHaveLength(1);

    socket.emit({ type: 'subscribed', topics: ['settings'] });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second.signals).toHaveLength(1);
  });

  it('pings on the heartbeat interval and clears the watchdog on any inbound frame', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(frames(socket).at(-1)).toEqual({ type: 'ping' });

    socket.emit({ type: 'pong' });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(
      frames(socket).filter((frame) => JSON.stringify(frame) === '{"type":"ping"}')
    ).toHaveLength(2);
    expect(socket.closedWith).toBeUndefined();
  });

  it('reconnects when a pong never arrives', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    vi.advanceTimersByTime(HEARTBEAT_MS);

    expect(socket.closedWith).toBeDefined();
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  /**
   * Proves exactly one failure was counted at the current moment: the armed retry
   * is the first-failure delay, and the escalation from there is 1000 ms rather
   * than the 2000 ms a double-counted failure would produce.
   */
  function expectSingleCountedFailure(): void {
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances, 'retry was not armed at the 500 ms delay').toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);

    makeReady();
    lastSocket().drop(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances, 'failure count escalated too far').toHaveLength(before + 1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 2);
  }

  it('ignores a late onclose from a socket it already abandoned', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();

    // Force the missed-pong reconnect: the client nulls its socket reference and
    // arms one timer at the first-failure delay.
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    // The abandoned socket now reports the close the browser observed.
    socket.drop(1006);

    expectSingleCountedFailure();
  });

  it('ignores a late frame from a socket it already abandoned', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();

    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    // A frame the half-open socket had already queued. Honoring it would flip the
    // phase back to ready and strand the client with no socket and no retry.
    socket.emit({ type: 'ready' });

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('drops its socket reference before closing, so a synchronous onclose is stale', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.closeFiresOnclose = true;

    // The forced close now re-enters the close handler synchronously.
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);

    expectSingleCountedFailure();
  });

  it('unsubscribes only the dropped topics after the linger window', () => {
    const client = createClient();
    const release = client.subscribe('git:chat-1', () => undefined);
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['git:chat-1', 'settings'] });

    release();
    vi.advanceTimersByTime(LINGER_MS - 1);
    expect(frames(socket)).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(frames(socket).at(-1)).toEqual({ type: 'unsubscribe', topics: ['git:chat-1'] });
    expect(socket.closedWith).toBeUndefined();
  });

  it('does not push an armed linger window out when another topic is dropped', () => {
    const client = createClient();
    const releaseFirst = client.subscribe('git:chat-1', () => undefined);
    const releaseSecond = client.subscribe('git:chat-2', () => undefined);
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['git:chat-1', 'git:chat-2', 'settings'] });

    releaseFirst();
    vi.advanceTimersByTime(3_000);
    releaseSecond();
    // The window still expires 5 s after the *first* drop, so a page churning
    // through chats cannot defer cleanup past the server's active-topic cap.
    vi.advanceTimersByTime(2_000);

    expect(frames(socket).at(-1)).toEqual({
      type: 'unsubscribe',
      topics: ['git:chat-1', 'git:chat-2'],
    });
  });

  it('sends no unsubscribe when the topic is wanted again by linger time', () => {
    const client = createClient();
    const release = client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['settings'] });

    release();
    client.subscribe('settings', () => undefined);
    vi.advanceTimersByTime(LINGER_MS);

    expect(frames(socket)).toEqual([{ type: 'subscribe', topics: ['settings'] }]);
    expect(socket.closedWith).toBeUndefined();
  });

  it('tears the socket down once nothing is wanted', () => {
    const client = createClient();
    const release = client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['settings'] });

    release();
    vi.advanceTimersByTime(LINGER_MS);
    expect(socket.closedWith).toBeDefined();

    // A later subscribe starts a fresh socket rather than reviving a dead one.
    client.subscribe('settings', () => undefined);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('re-subscribes a topic dropped and re-added after the linger reconcile', () => {
    const client = createClient();
    const release = client.subscribe('git:chat-1', () => undefined);
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['git:chat-1', 'settings'] });

    release();
    vi.advanceTimersByTime(LINGER_MS);

    client.subscribe('git:chat-1', () => undefined);
    vi.advanceTimersByTime(0);
    expect(frames(socket).at(-1)).toEqual({ type: 'subscribe', topics: ['git:chat-1'] });
  });

  it('unsubscribes a late subscribed ack for a topic already released past linger', () => {
    const client = createClient();
    const release = client.subscribe('git:chat-1', () => undefined);
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['git:chat-1', 'settings'] });

    release();
    vi.advanceTimersByTime(LINGER_MS);
    expect(frames(socket).at(-1)).toEqual({ type: 'unsubscribe', topics: ['git:chat-1'] });

    socket.emit({ type: 'subscribed', topics: ['git:chat-1'] });
    expect(frames(socket).at(-1)).toEqual({ type: 'unsubscribe', topics: ['git:chat-1'] });

    client.subscribe('git:chat-1', () => undefined);
    vi.advanceTimersByTime(0);
    expect(frames(socket).at(-1)).toEqual({ type: 'subscribe', topics: ['git:chat-1'] });
  });

  it('escalates the reconnect delay 500/1000/2000/4000/8000/15000', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    const schedule = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
    for (const [index, delay] of schedule.entries()) {
      lastSocket().drop(1006);
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances, `socket ${index + 1} opened early`).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances, `socket ${index + 2} did not open`).toHaveLength(index + 2);
    }
  });

  it('does not forgive failures without a full stability window', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    socketAt(0).drop(1006);
    vi.advanceTimersByTime(500);
    makeReady();

    vi.advanceTimersByTime(STABILITY_MS - 1);
    socketAt(1).drop(1006);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('forgives failures after a full stability window', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    socketAt(0).drop(1006);
    vi.advanceTimersByTime(500);
    makeReady();

    vi.advanceTimersByTime(STABILITY_MS);
    socketAt(1).drop(1006);

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('starts at the delay ceiling for a 4429 close', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    socketAt(0).drop(REALTIME_CLOSE_CODES.RATE_LIMITED);
    vi.advanceTimersByTime(14_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops for good on 4401 and returns to the auth flow once', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    socketAt(0).drop(REALTIME_CLOSE_CODES.UNAUTHORIZED);
    expect(onUnauthorized).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Terminal for the client's lifetime — a later mount must not reconnect.
    client.subscribe('git:chat-1', () => undefined);
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it.each([
    ['4403', REALTIME_CLOSE_CODES.FORBIDDEN],
    ['4400', REALTIME_CLOSE_CODES.INVALID_MESSAGE],
  ])('stops without redirecting on %s', (_label, code) => {
    const client = createClient();
    client.subscribe('settings', () => undefined);

    socketAt(0).drop(code);
    vi.advanceTimersByTime(120_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('cancels an armed reconnect once nothing is wanted', () => {
    const client = createClient();
    const release = client.subscribe('settings', () => undefined);

    socketAt(0).drop(1006);
    release();

    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('clears a reconnect armed beyond the linger window on teardown', () => {
    const client = createClient();
    const release = client.subscribe('settings', () => undefined);

    // Escalate until the armed delay (15 s) outlasts the 5 s linger window, so
    // teardown — not the reconnect callback — is what has to clear the timer.
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
      lastSocket().drop(1006);
      vi.advanceTimersByTime(delay);
    }
    lastSocket().drop(1006);
    const openedSockets = FakeWebSocket.instances.length;

    release();
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(openedSockets);
  });

  it('leaves topics unrequested when a send fails so the next connect re-sends them', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    expect(frames(socket)).toEqual([{ type: 'subscribe', topics: ['settings'] }]);

    // A socket that died without an onclose yet: the send throws.
    socket.readyState = FakeWebSocket.CLOSED;
    client.subscribe('git:chat-1', () => undefined);
    vi.advanceTimersByTime(0);
    expect(frames(socket)).toHaveLength(1);

    // Still unrequested, so the very next flush on this same socket re-sends it.
    socket.readyState = FakeWebSocket.OPEN;
    client.subscribe('git:chat-2', () => undefined);
    vi.advanceTimersByTime(0);
    expect(frames(socket).at(-1)).toEqual({
      type: 'subscribe',
      topics: ['git:chat-1', 'git:chat-2'],
    });

    socket.readyState = FakeWebSocket.CLOSED;
    socket.drop(1006);
    vi.advanceTimersByTime(500);
    expect(frames(makeReady())).toEqual([
      { type: 'subscribe', topics: ['settings', 'git:chat-1', 'git:chat-2'] },
    ]);
  });

  it('retries a topic the server rejected only on the next connection', () => {
    const client = createClient();
    client.subscribe('settings', () => undefined);
    client.subscribe('git:chat-1', () => undefined);
    const socket = makeReady();

    // Only `settings` is acked; the git topic came back as an error instead.
    socket.emit({ type: 'subscribed', topics: ['settings'] });
    socket.emit({ type: 'error', error: 'Realtime topic is unavailable', code: 'NOT_FOUND' });
    vi.advanceTimersByTime(LINGER_MS);
    expect(frames(socket)).toHaveLength(1);

    socket.drop(1006);
    vi.advanceTimersByTime(500);
    expect(frames(makeReady())).toEqual([
      { type: 'subscribe', topics: ['settings', 'git:chat-1'] },
    ]);
  });

  it('treats a socket constructor throw as a connection failure', () => {
    let attempts = 0;
    const client = createRealtimeClient({
      createSocket: (url) => {
        attempts += 1;
        if (attempts === 1) throw new Error('blocked scheme');
        return new FakeWebSocket(url) as unknown as WebSocket;
      },
      resolveUrl: () => 'ws://realtime.test/api/ws',
      onUnauthorized,
      random: () => 0,
    });

    client.subscribe('settings', () => undefined);
    expect(FakeWebSocket.instances).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('rejects an empty topic', () => {
    const client = createClient();
    expect(() => client.subscribe('', () => undefined)).toThrow(TypeError);
  });

  it('releases idempotently', () => {
    const client = createClient();
    const release = client.subscribe('settings', () => undefined);
    client.subscribe('settings', () => undefined);
    const socket = makeReady();
    socket.emit({ type: 'subscribed', topics: ['settings'] });

    release();
    release();
    vi.advanceTimersByTime(LINGER_MS);

    // One listener remains, so the topic is still wanted.
    expect(frames(socket)).toEqual([{ type: 'subscribe', topics: ['settings'] }]);
    expect(socket.closedWith).toBeUndefined();
  });
});

describe('getRealtimeClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    resetRealtimeClient();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetRealtimeClient();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns one shared client per tab', () => {
    expect(getRealtimeClient()).toBe(getRealtimeClient());
  });

  it('replaces the shared client after a 4401 so reauthentication can reconnect', () => {
    const shared = getRealtimeClient();
    shared.subscribe('settings', () => undefined);
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.emit({ type: 'ready' });
    socket?.drop(REALTIME_CLOSE_CODES.UNAUTHORIZED);

    const afterReject = getRealtimeClient();
    expect(afterReject).not.toBe(shared);
    afterReject.subscribe('settings', () => undefined);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('reconnects the shared socket when the authenticated user changes', () => {
    const client = getRealtimeClient();
    bindRealtimeClientToUser('user-a');
    client.subscribe('settings', () => undefined);
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.emit({ type: 'ready' });
    first?.emit({ type: 'subscribed', topics: ['settings'] });

    bindRealtimeClientToUser('user-b');
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first?.closedWith).toBeDefined();
  });

  it('does not clear the session binding when a stopped client linger fires after 4401', () => {
    const stopped = getRealtimeClient();
    const release = stopped.subscribe('settings', () => undefined);
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.emit({ type: 'ready' });
    first?.emit({ type: 'subscribed', topics: ['settings'] });
    first?.drop(REALTIME_CLOSE_CODES.UNAUTHORIZED);

    release();
    vi.advanceTimersByTime(LINGER_MS);

    const live = getRealtimeClient();
    bindRealtimeClientToUser('user-a');
    live.subscribe('settings', () => undefined);
    const second = FakeWebSocket.instances[1];
    second?.open();
    second?.emit({ type: 'ready' });
    second?.emit({ type: 'subscribed', topics: ['settings'] });

    bindRealtimeClientToUser('user-b');
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(second?.closedWith).toBeDefined();
  });
});
