import { Type, type Static } from '@sinclair/typebox';

export const SSEContextEventSchema = Type.Object({
  type: Type.Literal('context_info'),
  estimatedInputTokens: Type.Number(),
  contextLimit: Type.Number(),
  estimatedUsageRatio: Type.Number(),
  mode: Type.Union([
    Type.Literal('stateful'),
    Type.Literal('replay'),
    Type.Literal('compacted'),
    Type.Literal('degraded'),
  ]),
  severity: Type.Union([
    Type.Literal('normal'),
    Type.Literal('info'),
    Type.Literal('warning'),
    Type.Literal('danger'),
    Type.Literal('critical'),
  ]),
});

export type SSEContextEvent = Static<typeof SSEContextEventSchema>;

export const SSEThinkingStartEventSchema = Type.Object({
  type: Type.Literal('thinking_start'),
  done: Type.Literal(false),
});

export type SSEThinkingStartEvent = Static<typeof SSEThinkingStartEventSchema>;

export const SSEFallbackEventSchema = Type.Object({
  type: Type.Literal('fallback_notice'),
  from: Type.String(),
  to: Type.String(),
  reason: Type.String(),
});

export type SSEFallbackEvent = Static<typeof SSEFallbackEventSchema>;

export const SSESystemEventSchema = Type.Object({
  type: Type.Literal('system_event'),
  event: Type.String(),
  detail: Type.Optional(Type.String()),
  done: Type.Boolean(),
});

export type SSESystemEvent = Static<typeof SSESystemEventSchema>;

export const SSEErrorEventSchema = Type.Object({
  type: Type.Literal('error'),
  error: Type.String(),
  done: Type.Literal(true),
});

export type SSEErrorEvent = Static<typeof SSEErrorEventSchema>;
