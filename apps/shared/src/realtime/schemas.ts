import { type Static, Type } from '@sinclair/typebox';
import { ApiErrorResponseSchema } from '../errors/schemas';

/** Settings invalidation sections (app / provider / tool settings pages). */
export const SettingsScopeSchema = Type.Union([
  Type.Literal('app'),
  Type.Literal('provider'),
  Type.Literal('tool'),
]);
export type SettingsScope = Static<typeof SettingsScopeSchema>;

export const SETTINGS_SCOPES: readonly SettingsScope[] = SettingsScopeSchema.anyOf.map(
  (literal) => literal.const
);

/** Git panel cache slices; mirrors frontend invalidation scopes until PR 008 re-exports. */
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

const GIT_TOPIC_PREFIX = 'git:' as const;

/** Topic string for git-panel invalidation scoped to one chat. */
export function gitTopic(chatId: string): string {
  if (chatId.length === 0) {
    throw new TypeError('chatId must not be empty');
  }
  return `${GIT_TOPIC_PREFIX}${chatId}`;
}

/** Chat id encoded in a git invalidation topic (`git:<chatId>`). */
export function parseGitTopic(topic: string): string | undefined {
  if (!topic.startsWith(GIT_TOPIC_PREFIX)) {
    return undefined;
  }
  const chatId = topic.slice(GIT_TOPIC_PREFIX.length);
  return chatId.length > 0 ? chatId : undefined;
}

const TopicsArraySchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

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
    topic: Type.String({ pattern: '^git:.+$' }),
    scopes: Type.Optional(Type.Array(GitScopeSchema, { minItems: 1 })),
  },
  { additionalProperties: false }
);

export const RealtimeInvalidateMessageSchema = Type.Union([
  RealtimeSettingsInvalidateMessageSchema,
  RealtimeGitInvalidateMessageSchema,
]);
export type RealtimeInvalidateMessage = Static<typeof RealtimeInvalidateMessageSchema>;

/** Payload published on the in-process bus (invalidation signals only). */
export type RealtimeInvalidateEvent = RealtimeInvalidateMessage;

export const RealtimeErrorMessageSchema = Type.Composite(
  [
    Type.Object({
      type: Type.Literal('error'),
    }),
    ApiErrorResponseSchema,
  ],
  { additionalProperties: false }
);
export type RealtimeErrorMessage = Static<typeof RealtimeErrorMessageSchema>;

export const RealtimeServerMessageSchema = Type.Union([
  RealtimeReadyMessageSchema,
  RealtimePongMessageSchema,
  RealtimeInvalidateMessageSchema,
  RealtimeErrorMessageSchema,
]);
export type RealtimeServerMessage = Static<typeof RealtimeServerMessageSchema>;
