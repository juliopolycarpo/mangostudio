/**
 * Backward-compatibility barrel.
 * All contracts now live in bounded-context submodules.
 * This file re-exports everything so existing imports continue to work.
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
} from '../agents/contracts';
// App settings
export type { AppSettings, ImageQuality } from '../app-settings/contracts';
// Auth
export type { SignInBody, SignUpBody } from '../auth/schemas';
// Catalog
export type {
  ModelCapabilities,
  ModelCatalogResponse,
  ModelCatalogStatus,
  ModelOption,
} from '../catalog/contracts';
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
} from '../chat/schemas';
// Connectors
// Legacy alias (was exported from this file before split)
export type {
  Connector,
  ConnectorStatus,
  DeleteConnectorResponse,
  DeleteConnectorResponse as DeleteGeminiSecretResponse,
} from '../connectors/contracts';
export type { AddConnectorBody, UpdateConnectorModelsBody } from '../connectors/schemas';
// Errors
export type { ApiErrorResponse, SSEErrorEvent } from '../errors/contracts';
export type {
  GeneratedMessage,
  GenerateImageResponse,
  GenerateTextResponse,
} from '../generation/contracts';
// Generation
export type { GenerateImageBody, GenerateTextBody, RespondStreamBody } from '../generation/schemas';
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
} from '../observability/contracts';
// Prompt rules
export type {
  FixedRuleFileKind,
  RuleFileDescriptor,
  RuleFilePreviewBody,
  RuleFilePreviewResponse,
} from '../prompt-rules/contracts';
// Provider settings
export type {
  PromptCachePreference,
  ProviderRuntimeSettings,
  ProviderSettingScope,
  ProviderSettingsDescriptor,
  ProviderSettingsListResponse,
  ReasoningPolicy,
} from '../provider-settings/contracts';
// Streaming SSE events
export type {
  SSEContextEvent,
  SSEFallbackEvent,
  SSESystemEvent,
  SSEThinkingStartEvent,
} from '../streaming/events';
// Tool settings
export type {
  ToolParameterDescriptor,
  ToolParameterOption,
  ToolParameterType,
  ToolSettingsCategory,
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
} from '../tool-settings/contracts';
