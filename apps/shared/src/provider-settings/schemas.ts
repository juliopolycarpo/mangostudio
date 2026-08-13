import Type, { type Static } from 'typebox';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '../agentic-limits';
import { ReadonlyArraySchema } from '../schema-helpers';

export const ProviderTypeSchema = Type.Union([
  Type.Literal('gemini'),
  Type.Literal('openai'),
  Type.Literal('openai-compatible'),
  Type.Literal('anthropic'),
  Type.Literal('deepseek'),
  Type.Literal('cursor'),
  Type.Literal('chatgpt'),
]);

/**
 * Providers MangoStudio no longer owns, kept registered rather than deleted.
 *
 * A deprecated provider advertises no models, refuses execution and accepts no
 * new connector, but stays a recognizable provider type: a chat still carrying
 * one of its model ids has to resolve to a named refusal, not to an
 * unknown-provider crash. Existing connectors and their stored secrets survive.
 *
 * Cursor is here because it is reachable twice with inverted ownership — as a
 * MangoStudio-owned provider, and as an external agent that owns its own tools
 * and approvals. The external path is the supported one.
 */
export const DEPRECATED_PROVIDERS: ReadonlyArray<Static<typeof ProviderTypeSchema>> = ['cursor'];

/** True when this provider is deprecated. // Usage: isDeprecatedProvider('cursor') */
export function isDeprecatedProvider(
  provider: string
): provider is (typeof DEPRECATED_PROVIDERS)[number] {
  return (DEPRECATED_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * True when a stored model id belongs to a deprecated provider.
 *
 * Cursor ids are `cursor/…`. Hiding those providers from the catalog must not
 * rewrite a chat that still carries one — the next turn has to send the stored
 * id so the server can refuse it by name.
 */
export function isDeprecatedModelId(modelId: string): boolean {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return false;
  return isDeprecatedProvider(modelId.slice(0, slash));
}

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
  /**
   * MangoStudio no longer offers this provider. Not a capability flag: existing
   * connectors and their secrets stay, but execution is refused and new setup
   * is closed. The server is the authority — a client that hid a provider on
   * its own would still be able to POST a connector for it.
   */
  deprecated: Type.Boolean(),
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
export type ProviderSettingsDescriptor = Static<typeof ProviderSettingsDescriptorSchema>;
export type ProviderSettingsListResponse = Static<typeof ProviderSettingsListResponseSchema>;
