import { Type, type Static } from '@sinclair/typebox';

const ContinuationReasonCodeSchema = Type.Union([
  Type.Literal('provider_changed'),
  Type.Literal('model_changed'),
  Type.Literal('system_prompt_changed'),
  Type.Literal('toolset_changed'),
  Type.Literal('cursor_expired'),
  Type.Literal('cursor_invalid'),
  Type.Literal('tool_result_cursor_loss'),
  Type.Literal('envelope_malformed'),
]);

const ProviderTypeSchema = Type.Union([
  Type.Literal('gemini'),
  Type.Literal('openai'),
  Type.Literal('openai-compatible'),
  Type.Literal('anthropic'),
  Type.Literal('deepseek'),
]);

export const SSEContextEventSchema = Type.Object({
  type: Type.Literal('context_info'),
  estimatedInputTokens: Type.Number(),
  contextLimit: Type.Number(),
  estimatedUsageRatio: Type.Number(),
  mode: Type.Union([
    Type.Literal('stateful'),
    Type.Literal('stateless-loop'),
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
  done: Type.Literal(false),
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
  done: Type.Literal(false),
});

export type SSEFallbackEvent = Static<typeof SSEFallbackEventSchema>;

export const SSESystemEventSchema = Type.Object({
  type: Type.Literal('system_event'),
  event: Type.String(),
  detail: Type.Optional(Type.String()),
  done: Type.Boolean(),
});

export type SSESystemEvent = Static<typeof SSESystemEventSchema>;

export const SSEContinuationTransitionEventSchema = Type.Object({
  type: Type.Literal('continuation_transition'),
  provider: ProviderTypeSchema,
  modelName: Type.String(),
  fromProvider: Type.Optional(ProviderTypeSchema),
  fromMode: Type.String(),
  toMode: Type.String(),
  reasonCode: ContinuationReasonCodeSchema,
  detail: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

export type SSEContinuationTransitionEvent = Static<typeof SSEContinuationTransitionEventSchema>;

export const SSEErrorEventSchema = Type.Object({
  type: Type.Literal('error'),
  error: Type.String(),
  done: Type.Literal(true),
});

export type SSEErrorEvent = Static<typeof SSEErrorEventSchema>;
