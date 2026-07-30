import {
  REALTIME_CLOSE_CODES,
  REALTIME_IDLE_TIMEOUT_SECONDS,
  type RealtimeClientMessage,
  type RealtimeInvalidateMessage,
} from '@mangostudio/shared/realtime';
import { getWebSocketBaseUrl } from '../api-base-url';
import { scheduleLoginRedirect } from '../auth-navigate';
import { parseServerMessage } from './parse-server-message';

const REALTIME_PATH = '/api/ws';

/** Protocol cap on topics per subscribe/unsubscribe frame. */
const MAX_TOPICS_PER_FRAME = 32;

/**
 * Grace period before a dropped topic is reconciled away. Long enough that React
 * StrictMode's subscribe → unsubscribe → subscribe costs no frames, short enough
 * that a page cycling through chats cannot approach the 64-topic server cap.
 */
const LINGER_MS = 5_000;

/**
 * Heartbeat interval, derived from the server idle window so the two cannot
 * drift apart. Comfortably under the timeout even if one tick is missed.
 */
const HEARTBEAT_MS = Math.floor((REALTIME_IDLE_TIMEOUT_SECONDS * 1_000) / 2.5);

/** A connection must stay up this long before its failures are forgiven. */
const STABILITY_MS = 10_000;

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Lowest consecutive-failure count whose base delay already saturates the cap. */
const RECONNECT_MAX_FAILURES = 6;

export type RealtimeSignal =
  /** The topic is active on a live socket, so anything cached for it may predate it. */
  | { readonly type: 'subscribed' }
  | { readonly type: 'invalidate'; readonly message: RealtimeInvalidateMessage };

export type RealtimeTopicListener = (signal: RealtimeSignal) => void | Promise<void>;

export interface RealtimeClient {
  /** Ref-counted: the socket and the server-side topic are shared per tab. */
  subscribe(topic: string, listener: RealtimeTopicListener): () => void;
}

export interface RealtimeClientOptions {
  /** Socket factory — the seam unit tests use to drive the protocol. */
  readonly createSocket?: (url: string) => WebSocket;
  readonly resolveUrl?: () => string;
  /** Called once when the server rejects the session with `4401`. */
  readonly onUnauthorized?: () => void;
  /** Jitter source, injectable so the backoff schedule is assertable. */
  readonly random?: () => number;
}

/**
 * `connecting` deliberately spans both CONNECTING and OPEN-before-`ready`: no
 * client frame is legal in either state. `stopped` is terminal.
 */
type Phase = 'idle' | 'connecting' | 'ready' | 'waiting' | 'stopped';

const SUBSCRIBED_SIGNAL: RealtimeSignal = { type: 'subscribed' };

export function createRealtimeClient(options: RealtimeClientOptions = {}): RealtimeClient {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const resolveUrl = options.resolveUrl ?? (() => `${getWebSocketBaseUrl()}${REALTIME_PATH}`);
  const onUnauthorized = options.onUnauthorized ?? scheduleLoginRedirect;
  const random = options.random ?? Math.random;

  let phase: Phase = 'idle';
  let socket: WebSocket | null = null;
  /** Desired topic set — the keys *are* the desired set, values are the listeners. */
  const listeners = new Map<string, Set<RealtimeTopicListener>>();
  /** Sent to the current socket; cleared on close so the next one re-sends. */
  let requestedTopics = new Set<string>();
  /** Acknowledged by the current socket. */
  let activeTopics = new Set<string>();
  let failureCount = 0;
  let awaitingPong = false;

  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function stopHeartbeat(): void {
    if (heartbeatTimer === undefined) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function clearStabilityTimer(): void {
    if (stabilityTimer === undefined) return;
    clearTimeout(stabilityTimer);
    stabilityTimer = undefined;
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === undefined) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function clearFlushTimer(): void {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  function clearLingerTimer(): void {
    if (lingerTimer === undefined) return;
    clearTimeout(lingerTimer);
    lingerTimer = undefined;
  }

  function dispatch(topic: string, signal: RealtimeSignal): void {
    const topicListeners = listeners.get(topic);
    if (!topicListeners) return;
    // Copy: a listener is allowed to unsubscribe itself mid-dispatch.
    for (const listener of [...topicListeners]) {
      try {
        // Void and async listeners are both supported; a rejected promise must
        // not surface as an unhandled rejection.
        void Promise.resolve(listener(signal)).catch(() => undefined);
      } catch {
        // A throwing listener is contained — it must not take the socket down.
      }
    }
  }

  function sendMessage(message: RealtimeClientMessage): boolean {
    // Gated on the protocol phase, never on readyState: send() throws while
    // CONNECTING, and any frame before `ready` violates the contract even when
    // the transport is already OPEN.
    if (phase !== 'ready' || !socket) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function sendTopicFrames(type: 'subscribe' | 'unsubscribe', topics: readonly string[]): string[] {
    const delivered: string[] = [];
    for (let index = 0; index < topics.length; index += MAX_TOPICS_PER_FRAME) {
      const chunk = topics.slice(index, index + MAX_TOPICS_PER_FRAME);
      if (!sendMessage({ type, topics: chunk })) return delivered;
      delivered.push(...chunk);
    }
    return delivered;
  }

  function flushTopics(): void {
    clearFlushTimer();
    if (phase !== 'ready') return;
    const toAdd = [...listeners.keys()].filter((topic) => !requestedTopics.has(topic));
    if (toAdd.length === 0) return;
    // Only delivered chunks are marked as requested, so a failed send leaves its
    // topics for the next connect instead of stranding them.
    for (const topic of sendTopicFrames('subscribe', toAdd)) requestedTopics.add(topic);
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    // Coalesce same-tick adds so one render pass produces one subscribe frame.
    flushTimer = setTimeout(flushTopics, 0);
  }

  function closeSocket(): void {
    const current = socket;
    // Null the field *before* close() so a late onclose from this instance is
    // recognized as stale and cannot trigger a reconnect.
    socket = null;
    stopHeartbeat();
    clearStabilityTimer();
    try {
      current?.close();
    } catch {
      // Closing an already-closing socket is not actionable.
    }
  }

  function teardown(): void {
    // Unconditional, not gated on holding a socket: dropping the last listener
    // while a reconnect is armed has to clear that timer too.
    if (phase === 'stopped') return;
    clearReconnectTimer();
    clearFlushTimer();
    clearLingerTimer();
    closeSocket();
    requestedTopics = new Set();
    activeTopics = new Set();
    phase = 'idle';
  }

  function stop(): void {
    phase = 'stopped';
    socket = null;
    requestedTopics = new Set();
    activeTopics = new Set();
    clearReconnectTimer();
    clearFlushTimer();
    clearLingerTimer();
    stopHeartbeat();
    clearStabilityTimer();
  }

  function reconcileTopics(): void {
    lingerTimer = undefined;
    if (listeners.size === 0) {
      teardown();
      return;
    }
    if (phase !== 'ready') return;
    // A pure reconciler over current state, so the churn that armed this timer no
    // longer matters: a topic wanted again by fire time simply is not unwanted.
    const unwanted = [...activeTopics].filter((topic) => !listeners.has(topic));
    if (unwanted.length === 0) return;
    for (const topic of sendTopicFrames('unsubscribe', unwanted)) {
      activeTopics.delete(topic);
      requestedTopics.delete(topic);
    }
  }

  function scheduleLinger(): void {
    // Single-shot: an armed window is never pushed out, so a churning page cannot
    // defer server-side cleanup past the active-topic cap.
    if (lingerTimer !== undefined) return;
    lingerTimer = setTimeout(reconcileTopics, LINGER_MS);
  }

  function nextReconnectDelay(): number {
    const exponent = Math.min(failureCount, RECONNECT_MAX_FAILURES) - 1;
    const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
    // Half jitter, never full: a near-zero retry is exactly the case being bounded.
    return base / 2 + random() * (base / 2);
  }

  function scheduleReconnect(): void {
    // Never re-entered with a timer already armed: the only paths here are a
    // socket's own close (identity-guarded), a forced reconnect that nulls the
    // socket first, and a constructor throw — so the socket-identity guard is
    // what keeps this a single-owner timer.
    requestedTopics = new Set();
    activeTopics = new Set();
    if (listeners.size === 0) {
      phase = 'idle';
      return;
    }
    failureCount += 1;
    phase = 'waiting';
    reconnectTimer = setTimeout(onReconnect, nextReconnectDelay());
  }

  function onReconnect(): void {
    reconnectTimer = undefined;
    if (phase !== 'waiting') return;
    // Symmetric with teardown: the last listener may have gone while we waited.
    if (listeners.size === 0) {
      phase = 'idle';
      return;
    }
    connect();
  }

  function handleReady(): void {
    phase = 'ready';
    stopHeartbeat();
    heartbeatTimer = setInterval(onHeartbeat, HEARTBEAT_MS);
    clearStabilityTimer();
    // Backoff resets on proven stability rather than on `ready`, so a server that
    // acks and then drops — eight tabs against the connection cap — still
    // escalates instead of hot-looping.
    stabilityTimer = setTimeout(() => {
      stabilityTimer = undefined;
      failureCount = 0;
    }, STABILITY_MS);
    flushTopics();
  }

  function onHeartbeat(): void {
    if (phase !== 'ready') return;
    if (awaitingPong) {
      // A missed pong means the socket is half-open — the laptop-sleep case where
      // onclose never fires. Force the reconnect ourselves.
      closeSocket();
      scheduleReconnect();
      return;
    }
    if (sendMessage({ type: 'ping' })) awaitingPong = true;
  }

  function handleMessage(data: unknown): void {
    // Any inbound frame proves liveness, which is what makes the heartbeat a
    // watchdog rather than just a keepalive.
    awaitingPong = false;
    const message = parseServerMessage(data);
    if (!message) return;

    switch (message.type) {
      case 'ready':
        handleReady();
        return;
      case 'subscribed':
        for (const topic of message.topics) {
          activeTopics.add(topic);
          dispatch(topic, SUBSCRIBED_SIGNAL);
        }
        return;
      case 'invalidate':
        dispatch(message.topic, { type: 'invalidate', message });
        return;
      default:
        // `pong` needs nothing beyond the liveness clear above. An `error` names a
        // topic the server refused; it stays in requestedTopics so this socket
        // stops asking, and the next connect retries it once ownership may differ.
        return;
    }
  }

  function handleClose(code: number): void {
    stopHeartbeat();
    clearStabilityTimer();

    if (code === REALTIME_CLOSE_CODES.UNAUTHORIZED) {
      stop();
      onUnauthorized();
      return;
    }
    if (code === REALTIME_CLOSE_CODES.FORBIDDEN || code === REALTIME_CLOSE_CODES.INVALID_MESSAGE) {
      // Reconnecting would replay the identical rejection.
      stop();
      return;
    }
    if (code === REALTIME_CLOSE_CODES.RATE_LIMITED) {
      // Limit rejections start at the ceiling instead of walking up to it.
      failureCount = Math.max(failureCount, RECONNECT_MAX_FAILURES - 1);
    }
    scheduleReconnect();
  }

  function connect(): void {
    phase = 'connecting';
    requestedTopics = new Set();
    activeTopics = new Set();
    awaitingPong = false;

    let created: WebSocket;
    try {
      created = createSocket(resolveUrl());
    } catch {
      // A constructor throw (unusable URL, blocked scheme) is a connect failure.
      socket = null;
      scheduleReconnect();
      return;
    }
    socket = created;

    // Every handler re-checks socket identity so a stale instance — one already
    // replaced or deliberately closed — cannot drive live state.
    created.onmessage = (event: MessageEvent) => {
      if (socket !== created) return;
      handleMessage(event.data);
    };
    created.onclose = (event: CloseEvent) => {
      if (socket !== created) return;
      socket = null;
      handleClose(event.code);
    };
  }

  function subscribe(topic: string, listener: RealtimeTopicListener): () => void {
    if (topic.length === 0) throw new TypeError('topic must not be empty');

    let topicListeners = listeners.get(topic);
    if (!topicListeners) {
      topicListeners = new Set();
      listeners.set(topic, topicListeners);
    }
    topicListeners.add(listener);

    if (phase === 'idle') connect();
    scheduleFlush();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = listeners.get(topic);
      current?.delete(listener);
      if (current?.size === 0) listeners.delete(topic);
      scheduleLinger();
    };
  }

  return { subscribe };
}

let sharedClient: RealtimeClient | null = null;

/** The one socket per tab. Created on first use so no module import opens one. */
export function getRealtimeClient(): RealtimeClient {
  sharedClient ??= createRealtimeClient();
  return sharedClient;
}
