import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  REALTIME_CLOSE_CODES,
  type RealtimeClientMessage,
  type RealtimeInvalidateMessage,
} from '@mangostudio/shared/realtime';

import { getWebSocketBaseUrl } from '../api-base-url';
import { scheduleLoginRedirect } from '../auth-navigate';
import { parseServerMessage } from './parse-server-message';
import {
  nextReconnectDelay as sharedReconnectDelay,
  RECONNECT_MAX_FAILURES,
  SOCKET_HEARTBEAT_MS,
} from './reconnect-backoff';

const REALTIME_PATH = '/api/ws';

/** Protocol cap on topics per subscribe/unsubscribe frame. */
const MAX_TOPICS_PER_FRAME = 32;

/**
 * Grace period before a dropped topic is reconciled away. Long enough that React
 * StrictMode's subscribe → unsubscribe → subscribe costs no frames, short enough
 * that a page cycling through chats cannot approach the 64-topic server cap.
 */
const LINGER_MS = 5_000;

/** A connection must stay up this long before its failures are forgiven. */
const STABILITY_MS = 10_000;

export type RealtimeSignal =
  /** The topic is active on a live socket, so anything cached for it may predate it. */
  | {
      readonly type: 'subscribed';
      /**
       * When the frame that asked for this topic was sent (`Date.now()`). Data
       * read before it can have missed a write the hub processed before the
       * subscription took hold; data read after it cannot, since every later
       * write arrives as its own frame. Absent when the sender cannot say, which
       * a consumer must read as "the data may predate the subscription".
       */
      readonly requestedAt?: number;
    }
  | { readonly type: 'invalidate'; readonly message: RealtimeInvalidateMessage };

export type RealtimeTopicListener = (signal: RealtimeSignal) => void | Promise<void>;

export interface RealtimeClient {
  /** Ref-counted: the socket and the server-side topic are shared per tab. */
  subscribe(topic: string, listener: RealtimeTopicListener): () => void;
  /**
   * Drops the live transport and opens a new one when listeners remain. Used when
   * the authenticated user changes so the handshake picks up fresh cookies.
   */
  reconnectForSession(): void;
}

export interface RealtimeClientOptions {
  /** Socket factory — the seam unit tests use to drive the protocol. */
  readonly createSocket?: (url: string) => WebSocket;
  readonly resolveUrl?: () => string;
  /** Called once when the server rejects the session with `4401`. */
  readonly onUnauthorized?: () => void;
  /**
   * Called after the client enters the terminal `stopped` phase for `4401`.
   * The tab singleton uses this to drop the shared instance so a later
   * authenticated session gets a new socket instead of a dead one.
   */
  readonly onAuthSessionRejected?: () => void;
  /** Jitter source, injectable so the backoff schedule is assertable. */
  readonly random?: () => number;
}

/**
 * `connecting` deliberately spans both CONNECTING and OPEN-before-`ready`: no
 * client frame is legal in either state. `stopped` is terminal.
 */
type Phase = 'idle' | 'connecting' | 'ready' | 'waiting' | 'stopped';

export function createRealtimeClient(options: RealtimeClientOptions = {}): RealtimeClient {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const resolveUrl = options.resolveUrl ?? (() => `${getWebSocketBaseUrl()}${REALTIME_PATH}`);
  const onUnauthorized = options.onUnauthorized ?? scheduleLoginRedirect;
  const onAuthSessionRejected = options.onAuthSessionRejected;
  const random = options.random ?? Math.random;

  let phase: Phase = 'idle';
  let socket: WebSocket | null = null;
  /** Desired topic set — the keys *are* the desired set, values are the listeners. */
  const listeners = new Map<string, Set<RealtimeTopicListener>>();
  /**
   * Sent to the current socket, with the time the frame left; cleared on close
   * so the next one re-sends.
   */
  let requestedTopics = new Map<string, number>();
  /**
   * The hub refused a subscribe frame for the active-topic limit. Holds the
   * topics it refused back from the next flush until a reconcile has had a chance
   * to free room, since the same frame would fail the same way.
   */
  let subscriptionLimitHit = false;
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
    if (phase !== 'ready' || subscriptionLimitHit) return;
    const toAdd = [...listeners.keys()].filter((topic) => !requestedTopics.has(topic));
    if (toAdd.length === 0) return;
    const sentAt = Date.now();
    // Only delivered chunks are marked as requested, so a failed send leaves its
    // topics for the next connect instead of stranding them.
    for (const topic of sendTopicFrames('subscribe', toAdd)) requestedTopics.set(topic, sentAt);
  }

  /**
   * The hub refused a subscribe frame for the active-topic limit, whole and with
   * no ack. Topics that were asked for and never acked are not subscribed, so
   * they go back to wanted-but-unrequested and are resent once a reconcile has
   * unsubscribed enough lingering ones to make room.
   */
  function handleSubscriptionLimit(): void {
    for (const topic of requestedTopics.keys()) {
      if (!activeTopics.has(topic)) requestedTopics.delete(topic);
    }
    subscriptionLimitHit = true;
    // Make sure a reconcile is coming even when nothing was just released.
    scheduleLinger();
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
    requestedTopics = new Map();
    activeTopics = new Set();
    phase = 'idle';
  }

  function stop(): void {
    phase = 'stopped';
    socket = null;
    requestedTopics = new Map();
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
    const retryRefused = subscriptionLimitHit;
    subscriptionLimitHit = false;
    // A pure reconciler over current state, so the churn that armed this timer no
    // longer matters: a topic wanted again by fire time simply is not unwanted.
    const unwanted = [...activeTopics].filter((topic) => !listeners.has(topic));
    if (unwanted.length === 0) return;
    const freed = sendTopicFrames('unsubscribe', unwanted);
    for (const topic of freed) {
      activeTopics.delete(topic);
      requestedTopics.delete(topic);
    }
    // Retry only when room was made: with nothing to free, the refused frame
    // would be refused again, once per linger window, for as long as the page
    // wants more than the limit.
    if (retryRefused && freed.length > 0) scheduleFlush();
  }

  function scheduleLinger(): void {
    // Single-shot: an armed window is never pushed out, so a churning page cannot
    // defer server-side cleanup past the active-topic cap.
    if (lingerTimer !== undefined) return;
    lingerTimer = setTimeout(reconcileTopics, LINGER_MS);
  }

  function nextReconnectDelay(): number {
    return sharedReconnectDelay(failureCount, random);
  }

  function scheduleReconnect(): void {
    // Never re-entered with a timer already armed: the only paths here are a
    // socket's own close (identity-guarded), a forced reconnect that nulls the
    // socket first, and a constructor throw — so the socket-identity guard is
    // what keeps this a single-owner timer.
    requestedTopics = new Map();
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
    heartbeatTimer = setInterval(onHeartbeat, SOCKET_HEARTBEAT_MS);
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
      case 'subscribed': {
        const stale: string[] = [];
        for (const topic of message.topics) {
          if (!listeners.has(topic)) {
            stale.push(topic);
            continue;
          }
          activeTopics.add(topic);
          dispatch(topic, {
            type: 'subscribed',
            requestedAt: requestedTopics.get(topic) ?? Date.now(),
          });
        }
        if (stale.length > 0) {
          sendTopicFrames('unsubscribe', stale);
          for (const topic of stale) requestedTopics.delete(topic);
        }
        return;
      }
      case 'invalidate':
        dispatch(message.topic, { type: 'invalidate', message });
        return;
      case 'error':
        // A topic the server refused for ownership or support stays in
        // requestedTopics so this socket stops asking, and the next connect
        // retries it once ownership may differ. The topic limit is different: it
        // refuses a whole frame over a transient count, so it is retried here.
        if (message.code === ERROR_CODES.RATE_LIMITED) handleSubscriptionLimit();
        return;
      default:
        // `pong` needs nothing beyond the liveness clear above.
        return;
    }
  }

  function handleClose(code: number): void {
    stopHeartbeat();
    clearStabilityTimer();

    if (code === REALTIME_CLOSE_CODES.UNAUTHORIZED) {
      stop();
      onAuthSessionRejected?.();
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
    subscriptionLimitHit = false;
    requestedTopics = new Map();
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

  function reconnectForSession(): void {
    if (phase === 'stopped') return;
    clearReconnectTimer();
    clearFlushTimer();
    clearLingerTimer();
    closeSocket();
    requestedTopics = new Map();
    activeTopics = new Set();
    awaitingPong = false;
    if (listeners.size === 0) {
      phase = 'idle';
      return;
    }
    connect();
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

  return { subscribe, reconnectForSession };
}

let sharedClient: RealtimeClient | null = null;
/** Last user bound to the tab singleton; cleared when the socket fully tears down. */
let boundAuthenticatedUserId: string | undefined;

/**
 * Ensures the shared socket was authenticated for `userId`. Reconnects when the
 * signed-in user changes so a linger window cannot keep the previous session.
 */
export function bindRealtimeClientToUser(userId: string): void {
  const previous = boundAuthenticatedUserId;
  if (previous === userId) return;
  boundAuthenticatedUserId = userId;
  if (previous !== undefined) sharedClient?.reconnectForSession();
}

/** Drops the tab singleton so the next subscribe opens a new connection. */
export function resetRealtimeClient(): void {
  sharedClient = null;
  boundAuthenticatedUserId = undefined;
}

/** The one socket per tab. Created on first use so no module import opens one. */
export function getRealtimeClient(): RealtimeClient {
  sharedClient ??= createRealtimeClient({
    onAuthSessionRejected: () => {
      sharedClient = null;
    },
  });
  return sharedClient;
}
