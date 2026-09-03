import Type, { type Static } from 'typebox';
import { ApiErrorResponseSchema } from '../errors/schemas';

/**
 * Settings invalidation sections. The first three are the settings pages; the
 * fourth is the tool identity registry, which shares the topic because it is
 * one more per-user preference store — but it is read far outside settings, so
 * its subscriber lives with the identity query rather than on the settings
 * layout.
 */
export const SettingsScopeSchema = Type.Union([
  Type.Literal('app'),
  Type.Literal('provider'),
  Type.Literal('tool'),
  Type.Literal('tool-identity'),
]);
export type SettingsScope = Static<typeof SettingsScopeSchema>;

export const SETTINGS_SCOPES: readonly SettingsScope[] = SettingsScopeSchema.anyOf.map(
  (literal) => literal.const
);

/** Git panel cache slices. Single source of truth for the frontend's write-scope map. */
export const GitScopeSchema = Type.Union([
  Type.Literal('state'),
  Type.Literal('stashes'),
  Type.Literal('branches'),
  Type.Literal('history'),
  Type.Literal('commits'),
  Type.Literal('diffs'),
  Type.Literal('github'),
]);
export type GitScope = Static<typeof GitScopeSchema>;

export const GIT_SCOPES: readonly GitScope[] = GitScopeSchema.anyOf.map((literal) => literal.const);

export const SETTINGS_TOPIC = 'settings' as const;
export const ENVIRONMENTS_TOPIC = 'environments' as const;
/**
 * External-agent discovery answers, separate from the environments topic on
 * purpose.
 *
 * The two mean different things. `environments` means the machine changed —
 * a runtime connected or dropped, an environment was edited — and every
 * in-process cache keyed on it is dropped in response. This topic means only
 * that a background probe learned something better about a machine that did not
 * change, so nothing may reset a cache on it: a signal that invalidated the
 * discovery cache would make the next request miss, probe, publish and reset
 * again, one vendor subprocess per cycle, per user, without end.
 */
export const EXTERNAL_AGENTS_TOPIC = 'external-agents' as const;
/**
 * "Something worth reporting happened on this account."
 *
 * One topic for every activity kind rather than one per producer: the feed is a
 * single query, and the consumers that piggyback on it (the chat list, which
 * `chat_created`/`turn_completed` already imply is stale) want the same
 * coarse signal. Splitting it would buy nothing but frames.
 */
export const ACTIVITY_TOPIC = 'activity' as const;

const GIT_TOPIC_PREFIX = 'git:' as const;
const MAX_REALTIME_TOPICS_PER_MESSAGE = 32;
const MAX_REALTIME_TOPIC_LENGTH = 256;

/** Topic string for git-panel invalidation scoped to one chat. */
export function gitTopic(chatId: string): string {
  if (chatId.length === 0) {
    throw new TypeError('chatId must not be empty');
  }
  const topic = `${GIT_TOPIC_PREFIX}${chatId}`;
  if (topic.length > MAX_REALTIME_TOPIC_LENGTH) {
    throw new TypeError(`git topic must not exceed ${MAX_REALTIME_TOPIC_LENGTH} characters`);
  }
  return topic;
}

/** Chat id encoded in a git invalidation topic (`git:<chatId>`). */
export function parseGitTopic(topic: string): string | undefined {
  if (!topic.startsWith(GIT_TOPIC_PREFIX) || topic.length > MAX_REALTIME_TOPIC_LENGTH) {
    return undefined;
  }
  const chatId = topic.slice(GIT_TOPIC_PREFIX.length);
  return chatId.length > 0 ? chatId : undefined;
}

const TopicsArraySchema = Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_REALTIME_TOPIC_LENGTH }),
  {
    minItems: 1,
    maxItems: MAX_REALTIME_TOPICS_PER_MESSAGE,
  }
);

export const RealtimeSubscribeMessageSchema = Type.Object(
  {
    type: Type.Literal('subscribe'),
    topics: TopicsArraySchema,
  },
  { additionalProperties: false }
);
export type RealtimeSubscribeMessage = Static<typeof RealtimeSubscribeMessageSchema>;

export const RealtimeUnsubscribeMessageSchema = Type.Object(
  {
    type: Type.Literal('unsubscribe'),
    topics: TopicsArraySchema,
  },
  { additionalProperties: false }
);
export type RealtimeUnsubscribeMessage = Static<typeof RealtimeUnsubscribeMessageSchema>;

export const RealtimePingMessageSchema = Type.Object(
  {
    type: Type.Literal('ping'),
  },
  { additionalProperties: false }
);
export type RealtimePingMessage = Static<typeof RealtimePingMessageSchema>;

export const RealtimeClientMessageSchema = Type.Union([
  RealtimeSubscribeMessageSchema,
  RealtimeUnsubscribeMessageSchema,
  RealtimePingMessageSchema,
]);
export type RealtimeClientMessage = Static<typeof RealtimeClientMessageSchema>;

export const RealtimeReadyMessageSchema = Type.Object(
  {
    type: Type.Literal('ready'),
  },
  { additionalProperties: false }
);
export type RealtimeReadyMessage = Static<typeof RealtimeReadyMessageSchema>;

export const RealtimeSubscribedMessageSchema = Type.Object(
  {
    type: Type.Literal('subscribed'),
    topics: TopicsArraySchema,
  },
  { additionalProperties: false }
);
export type RealtimeSubscribedMessage = Static<typeof RealtimeSubscribedMessageSchema>;

export const RealtimePongMessageSchema = Type.Object(
  {
    type: Type.Literal('pong'),
  },
  { additionalProperties: false }
);
export type RealtimePongMessage = Static<typeof RealtimePongMessageSchema>;

const RealtimeSettingsInvalidateMessageSchema = Type.Object(
  {
    type: Type.Literal('invalidate'),
    topic: Type.Literal(SETTINGS_TOPIC),
    scopes: Type.Optional(Type.Array(SettingsScopeSchema, { minItems: 1 })),
  },
  { additionalProperties: false }
);

const RealtimeGitInvalidateMessageSchema = Type.Object(
  {
    type: Type.Literal('invalidate'),
    topic: Type.String({ pattern: '^git:.+$', maxLength: MAX_REALTIME_TOPIC_LENGTH }),
    scopes: Type.Optional(Type.Array(GitScopeSchema, { minItems: 1 })),
  },
  { additionalProperties: false }
);

const RealtimeEnvironmentsInvalidateMessageSchema = Type.Object(
  {
    type: Type.Literal('invalidate'),
    topic: Type.Literal(ENVIRONMENTS_TOPIC),
    /** Keeps the invalidate union ergonomic while rejecting scopes on this topic. */
    scopes: Type.Optional(Type.Never()),
  },
  { additionalProperties: false }
);

const RealtimeExternalAgentsInvalidateMessageSchema = Type.Object(
  {
    type: Type.Literal('invalidate'),
    topic: Type.Literal(EXTERNAL_AGENTS_TOPIC),
    /** Keeps the invalidate union ergonomic while rejecting scopes on this topic. */
    scopes: Type.Optional(Type.Never()),
  },
  { additionalProperties: false }
);

const RealtimeActivityInvalidateMessageSchema = Type.Object(
  {
    type: Type.Literal('invalidate'),
    topic: Type.Literal(ACTIVITY_TOPIC),
    /** Keeps the invalidate union ergonomic while rejecting scopes on this topic. */
    scopes: Type.Optional(Type.Never()),
  },
  { additionalProperties: false }
);

export const RealtimeInvalidateMessageSchema = Type.Union([
  RealtimeSettingsInvalidateMessageSchema,
  RealtimeEnvironmentsInvalidateMessageSchema,
  RealtimeExternalAgentsInvalidateMessageSchema,
  RealtimeActivityInvalidateMessageSchema,
  RealtimeGitInvalidateMessageSchema,
]);
export type RealtimeInvalidateMessage = Static<typeof RealtimeInvalidateMessageSchema>;

/** Payload published on the in-process bus (invalidation signals only). */
export type RealtimeInvalidateEvent = RealtimeInvalidateMessage;

export const RealtimeErrorMessageSchema = Type.Interface(
  [
    Type.Object({
      type: Type.Literal('error'),
    }),
    ApiErrorResponseSchema,
  ],
  {},
  { additionalProperties: false }
);
export type RealtimeErrorMessage = Static<typeof RealtimeErrorMessageSchema>;

export const RealtimeServerMessageSchema = Type.Union([
  RealtimeReadyMessageSchema,
  RealtimeSubscribedMessageSchema,
  RealtimePongMessageSchema,
  RealtimeInvalidateMessageSchema,
  RealtimeErrorMessageSchema,
]);
export type RealtimeServerMessage = Static<typeof RealtimeServerMessageSchema>;

/**
 * Server-side idle timeout. Clients derive their heartbeat interval from this
 * value so the ping cadence cannot drift away from the window it must beat.
 */
export const REALTIME_IDLE_TIMEOUT_SECONDS = 60;

/**
 * Largest payload any hub WebSocket route accepts. Applied process-wide, so it
 * bounds every browser socket, not just `/api/ws`. uWebSockets refuses a payload
 * *greater* than this, so a client limit equal to it is the largest that still
 * arrives; anything above closes the socket with 1009.
 */
export const HUB_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * Queued-bytes ceiling before the hub closes a socket for backpressure. A route
 * that queues its own frames must stay below this rather than let Bun decide.
 */
export const HUB_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES = 64 * 1024;

/** Stable close codes used by WebSocket clients to choose reconnect behavior. */
export const REALTIME_CLOSE_CODES = {
  INVALID_MESSAGE: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  RATE_LIMITED: 4429,
  INTERNAL_ERROR: 1011,
} as const;
