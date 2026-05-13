/**
 * Backward-compatibility barrel.
 * All contracts now live in bounded-context submodules.
 * This file re-exports everything so existing imports continue to work.
 */

// Errors
export type { ApiErrorResponse } from '../errors/contracts';
export type { SSEErrorEvent } from '../errors/contracts';

// Chat
export type {
  CompactChatBody,
  ContextCompactionBehavior,
  ContextCompactionResponse,
  ContextInfo,
  ContextSettings,
  CreateChatBody,
  SummarizeToNewChatBody,
  UpdateChatBody,
  CreateMessageBody,
  UpdateMessageBody,
} from '../chat/schemas';

// Generation
export type { GenerateImageBody, GenerateTextBody, RespondStreamBody } from '../generation/schemas';
export type {
  GeneratedMessage,
  GenerateImageResponse,
  GenerateTextResponse,
} from '../generation/contracts';

// Connectors
export type { Connector, ConnectorStatus, DeleteConnectorResponse } from '../connectors/contracts';
export type { AddConnectorBody, UpdateConnectorModelsBody } from '../connectors/schemas';

// Catalog
export type {
  ModelCatalogStatus,
  ModelCapabilities,
  ModelOption,
  ModelCatalogResponse,
} from '../catalog/contracts';

// App settings
export type { AppSettings, ImageQuality } from '../app-settings/contracts';

// Provider settings
export type {
  PromptCachePreference,
  ProviderRuntimeSettings,
  ProviderSettingsDescriptor,
  ProviderSettingsListResponse,
  ProviderSettingScope,
  ReasoningPolicy,
} from '../provider-settings/contracts';

// Tool settings
export type {
  ToolParameterDescriptor,
  ToolParameterOption,
  ToolParameterType,
  ToolSettingsCategory,
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
} from '../tool-settings/contracts';

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

// Auth
export type { SignUpBody, SignInBody } from '../auth/schemas';

// Streaming SSE events
export type {
  SSEContextEvent,
  SSEThinkingStartEvent,
  SSEFallbackEvent,
  SSESystemEvent,
} from '../streaming/events';

// Prompt rules
export type {
  FixedRuleFileKind,
  RuleFileDescriptor,
  RuleFilePreviewBody,
  RuleFilePreviewResponse,
} from '../prompt-rules/contracts';

// Legacy alias (was exported from this file before split)
export type { DeleteConnectorResponse as DeleteGeminiSecretResponse } from '../connectors/contracts';
