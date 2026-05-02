import { Type, type Static } from '@sinclair/typebox';

export const ProviderTypeSchema = Type.Union([
  Type.Literal('gemini'),
  Type.Literal('openai'),
  Type.Literal('openai-compatible'),
  Type.Literal('anthropic'),
  Type.Literal('deepseek'),
]);

export const ReasoningEffortSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);

export const PromptCachePreferenceSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('stable-prefix'),
  Type.Literal('off'),
]);

export const ReasoningPolicySchema = Type.Object({
  supportedEfforts: Type.Array(ReasoningEffortSchema, { minItems: 1 }),
  defaultEffort: ReasoningEffortSchema,
  maxEffort: Type.Optional(ReasoningEffortSchema),
  thinkingToggleSupported: Type.Boolean(),
  reasoningWithToolsSupported: Type.Boolean(),
});

export const ProviderRuntimeSettingsSchema = Type.Object({
  provider: ProviderTypeSchema,
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maxToolIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  providerCompactionEnabled: Type.Optional(Type.Boolean()),
  promptCachePreference: Type.Optional(PromptCachePreferenceSchema),
  parallelToolCallsEnabled: Type.Optional(Type.Boolean()),
});

export const UpdateProviderRuntimeSettingsBodySchema = Type.Object({
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maxToolIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  providerCompactionEnabled: Type.Optional(Type.Boolean()),
  promptCachePreference: Type.Optional(PromptCachePreferenceSchema),
  parallelToolCallsEnabled: Type.Optional(Type.Boolean()),
});

export const ProviderSettingsDescriptorSchema = Type.Object({
  provider: ProviderTypeSchema,
  displayName: Type.String(),
  scope: Type.Literal('provider'),
  reasoning: ReasoningPolicySchema,
  promptCachingSupported: Type.Boolean(),
  toolUseSupported: Type.Boolean(),
  structuredOutputSupported: Type.Boolean(),
  maxOutputTokensLimit: Type.Integer({ minimum: 1 }),
  settings: ProviderRuntimeSettingsSchema,
});

export const ProviderSettingsListResponseSchema = Type.Object({
  providers: Type.Array(ProviderSettingsDescriptorSchema),
});

export type ProviderRuntimeSettings = Static<typeof ProviderRuntimeSettingsSchema>;
export type UpdateProviderRuntimeSettingsBody = Static<
  typeof UpdateProviderRuntimeSettingsBodySchema
>;
export type ProviderSettingsDescriptor = Static<typeof ProviderSettingsDescriptorSchema>;
export type ProviderSettingsListResponse = Static<typeof ProviderSettingsListResponseSchema>;
