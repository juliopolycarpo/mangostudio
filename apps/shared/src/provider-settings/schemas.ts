import { type Static, Type } from '@sinclair/typebox';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '../agentic-limits';
import { ReadonlyArraySchema } from '../schema-helpers';

export const ProviderTypeSchema = Type.Union([
  Type.Literal('gemini'),
  Type.Literal('openai'),
  Type.Literal('openai-compatible'),
  Type.Literal('anthropic'),
  Type.Literal('deepseek'),
  Type.Literal('cursor'),
]);

export const ProviderSettingScopeSchema = Type.Literal('provider');

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
  supportedEfforts: ReadonlyArraySchema(ReasoningEffortSchema, { minItems: 1 }),
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
  maxToolIterations: Type.Optional(
    Type.Integer({ minimum: MAX_TOOL_ITERATIONS_MIN, maximum: MAX_TOOL_ITERATIONS_MAX })
  ),
  providerCompactionEnabled: Type.Optional(Type.Boolean()),
  promptCachePreference: Type.Optional(PromptCachePreferenceSchema),
  parallelToolCallsEnabled: Type.Optional(Type.Boolean()),
});

export const CURSOR_MIN_NODE_VERSION = '22.13';

export const ProviderRuntimeUnavailableReasonSchema = Type.Union([
  Type.Literal('cursor.node_not_found'),
  Type.Literal('cursor.version_insufficient'),
  Type.Literal('cursor.sidecar_missing'),
  Type.Literal('cursor.sdk_missing'),
  Type.Literal('cursor.sdk_incomplete'),
  Type.Literal('cursor.native_runtime_missing'),
]);

export const ProviderRuntimeUnavailableReasonParamsSchema = Type.Object({
  foundVersion: Type.Optional(Type.String()),
  packageName: Type.Optional(Type.String()),
  sidecarPath: Type.Optional(Type.String()),
});

export const UpdateProviderRuntimeSettingsBodySchema = Type.Object({
  thinkingEnabled: Type.Optional(Type.Boolean()),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maxToolIterations: Type.Optional(
    Type.Integer({ minimum: MAX_TOOL_ITERATIONS_MIN, maximum: MAX_TOOL_ITERATIONS_MAX })
  ),
  providerCompactionEnabled: Type.Optional(Type.Boolean()),
  promptCachePreference: Type.Optional(PromptCachePreferenceSchema),
  parallelToolCallsEnabled: Type.Optional(Type.Boolean()),
});

export const ProviderSettingsDescriptorSchema = Type.Object({
  provider: ProviderTypeSchema,
  displayName: Type.String(),
  scope: ProviderSettingScopeSchema,
  reasoning: ReasoningPolicySchema,
  promptCachingSupported: Type.Boolean(),
  toolUseSupported: Type.Boolean(),
  structuredOutputSupported: Type.Boolean(),
  maxOutputTokensLimit: Type.Integer({ minimum: 1 }),
  settings: ProviderRuntimeSettingsSchema,
  runtimeAvailable: Type.Boolean(),
  runtimeUnavailableReason: Type.Optional(ProviderRuntimeUnavailableReasonSchema),
  runtimeUnavailableReasonParams: Type.Optional(ProviderRuntimeUnavailableReasonParamsSchema),
});

export const ProviderSettingsListResponseSchema = Type.Object({
  providers: Type.Array(ProviderSettingsDescriptorSchema),
});

export type ProviderSettingScope = Static<typeof ProviderSettingScopeSchema>;
export type PromptCachePreference = Static<typeof PromptCachePreferenceSchema>;
export type ReasoningPolicy = Static<typeof ReasoningPolicySchema>;
export type ProviderRuntimeSettings = Static<typeof ProviderRuntimeSettingsSchema>;
export type UpdateProviderRuntimeSettingsBody = Static<
  typeof UpdateProviderRuntimeSettingsBodySchema
>;
export type ProviderRuntimeUnavailableReason = Static<
  typeof ProviderRuntimeUnavailableReasonSchema
>;
export type ProviderRuntimeUnavailableReasonParams = Static<
  typeof ProviderRuntimeUnavailableReasonParamsSchema
>;
export type ProviderSettingsDescriptor = Static<typeof ProviderSettingsDescriptorSchema>;
export type ProviderSettingsListResponse = Static<typeof ProviderSettingsListResponseSchema>;
