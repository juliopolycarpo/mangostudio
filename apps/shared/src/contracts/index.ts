/**
 * Backward-compatibility barrel.
 *
 * Contracts live in bounded-context submodules where TypeBox schemas
 * (`<module>/schemas.ts`) are the canonical source of truth and public types are
 * derived via `Static<>`. This file only re-exports the public types so existing
 * `@mangostudio/shared/contracts` imports keep working — prefer importing from
 * the bounded-context entrypoint (e.g. `@mangostudio/shared/agents`) in new code.
 */

// Agents
export type {
  AgentExecutionMode,
  AgentId,
  AgentKind,
  AgentMarkdownPreviewBody,
  AgentMarkdownPreviewResponse,
  AgentMetadata,
  AgentProfile,
  AgentProfileListResponse,
  AgentProfileUpsertBody,
  AgentRole,
  AgentSource,
  BuiltInAgentId,
  CreateAgentProfileBody,
  DeleteAgentProfileResponse,
  UserAgentId,
} from '../agents';
// App settings
export type { AppSettings, ImageQuality } from '../app-settings';
// Auth
export type { SignInBody, SignUpBody } from '../auth';
// Catalog
export type {
  ModelCapabilities,
  ModelCatalogResponse,
  ModelCatalogStatus,
  ModelOption,
} from '../catalog';
// Chat
export type {
  CompactChatBody,
  ContextCompactionBehavior,
  ContextCompactionResponse,
  ContextInfo,
  ContextSettings,
  CreateChatBody,
  CreateMessageBody,
  SummarizeToNewChatBody,
  UpdateChatBody,
  UpdateMessageBody,
} from '../chat';
// Connectors
export type {
  AddConnectorBody,
  Connector,
  ConnectorStatus,
  DeleteConnectorResponse,
  // Legacy alias (was exported from this file before the split)
  DeleteConnectorResponse as DeleteGeminiSecretResponse,
  UpdateConnectorModelsBody,
} from '../connectors';
// Errors
export type { ApiErrorResponse, SSEErrorEvent } from '../errors';
// Generation
export type {
  GeneratedMessage,
  GenerateImageResponse,
  GenerateTextResponse,
} from '../generation';
// Observability
export type {
  ObservabilityLogKind,
  ProviderCacheMetrics,
  ProviderCacheName,
  ProviderObservabilityLogEntry,
  ProviderObservabilityLogsResponse,
  ProviderObservabilityMetrics,
  ProviderObservabilityMetricsResponse,
  ProviderProbeMetrics,
  ProviderProbeOperation,
  ProviderUsageKind,
  ProviderUsageMetrics,
} from '../observability';
// Prompt rules
export type {
  FixedRuleFileKind,
  RuleFileDescriptor,
  RuleFilePreviewBody,
  RuleFilePreviewResponse,
} from '../prompt-rules';
// Provider settings
export type {
  PromptCachePreference,
  ProviderRuntimeSettings,
  ProviderSettingScope,
  ProviderSettingsDescriptor,
  ProviderSettingsListResponse,
  ReasoningPolicy,
} from '../provider-settings';
// Skills
export type { SkillDescriptor, SkillListResponse, SkillSource } from '../skills';
// Streaming SSE events
export type {
  SSEContextEvent,
  SSEFallbackEvent,
  SSESystemEvent,
  SSEThinkingStartEvent,
} from '../streaming';
// Tool settings
export type {
  ToolParameterDescriptor,
  ToolParameterOption,
  ToolParameterType,
  ToolSettingsCategory,
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
} from '../tool-settings';
