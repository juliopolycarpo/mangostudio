import type {
  RealtimeErrorMessage,
  RealtimeInvalidateMessage,
  RealtimeServerMessage,
  RealtimeSubscribedMessage,
} from '@mangostudio/shared/realtime';

/**
 * Exhaustiveness table over the shared server-message union. Adding a variant to
 * `RealtimeServerMessage` without a branch in `parseServerMessage` becomes a
 * build error here instead of a frame this client silently drops.
 */
const SERVER_MESSAGE_TYPES = {
  ready: true,
  subscribed: true,
  pong: true,
  invalidate: true,
  error: true,
} satisfies Record<RealtimeServerMessage['type'], true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

function parseSubscribed(frame: Record<string, unknown>): RealtimeSubscribedMessage | null {
  if (!isNonEmptyStringArray(frame.topics)) return null;
  return { type: 'subscribed', topics: frame.topics };
}

function parseInvalidate(frame: Record<string, unknown>): RealtimeInvalidateMessage | null {
  const { topic, scopes } = frame;
  if (typeof topic !== 'string' || topic.length === 0) return null;
  if (scopes !== undefined && !isNonEmptyStringArray(scopes)) return null;
  // Scope strings are shape-checked but deliberately not matched against the
  // current scope unions: a newer server must be able to add a scope without
  // this client discarding the whole frame. Callers therefore must not switch
  // exhaustively on a scope without a default branch.
  return {
    type: 'invalidate',
    topic,
    ...(scopes === undefined ? {} : { scopes }),
  } as RealtimeInvalidateMessage;
}

function parseError(frame: Record<string, unknown>): RealtimeErrorMessage | null {
  const { error, code } = frame;
  if (typeof error !== 'string') return null;
  if (code !== undefined && typeof code !== 'string') return null;
  return { type: 'error', error, ...(code === undefined ? {} : { code }) };
}

/**
 * Narrows a raw WebSocket payload to a server message, or `null` when the frame
 * is unusable.
 *
 * The route validates every outbound frame against `RealtimeServerMessageSchema`,
 * so this is a defensive narrowing rather than a second validation layer — which
 * is why the frontend needs no TypeBox dependency.
 */
export function parseServerMessage(data: unknown): RealtimeServerMessage | null {
  if (typeof data !== 'string') return null;

  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(frame)) return null;

  const { type } = frame;
  if (typeof type !== 'string' || !(type in SERVER_MESSAGE_TYPES)) return null;

  switch (type as RealtimeServerMessage['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'pong':
      return { type: 'pong' };
    case 'subscribed':
      return parseSubscribed(frame);
    case 'invalidate':
      return parseInvalidate(frame);
    case 'error':
      return parseError(frame);
    default:
      return null;
  }
}
