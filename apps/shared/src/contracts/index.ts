/**
 * API request/response contracts (DTOs).
 * These define the shape of data exchanged between frontend and API.
 */

export type { SSEErrorEvent } from './errors';

import type {
  InteractionMode,
  MessagePart,
  SecretSource,
  SecretMetadataRow,
  ProviderType,
} from '../types/index';

/** Body for POST /api/chats */
export interface CreateChatBody {
  title: string;
  model?: string;
}

/** Body for PUT /api/chats/:id */
export interface UpdateChatBody {
  title?: string;
  model?: string;
  textModel?: string;
  imageModel?: string;
  lastUsedMode?: InteractionMode;
}

/** Body for POST /api/messages */
export interface CreateMessageBody {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string;
  referenceImage?: string;
  timestamp: number;
  isGenerating?: boolean;
  generationTime?: string;
  modelName?: string;
  styleParams?: string[];
  interactionMode?: InteractionMode;
}

/** Body for PUT /api/messages/:id */
export interface UpdateMessageBody {
  text?: string;
  imageUrl?: string;
  isGenerating?: boolean;
  generationTime?: string;
  modelName?: string;
  styleParams?: string[];
}

/** Body for POST /api/generate */
export interface GenerateImageBody {
  /** The chat to associate messages with. */
  chatId: string;
  prompt: string;
  systemPrompt?: string;
  referenceImageUrl?: string;
  imageQuality?: string;
  model?: string;
}

/** Response for POST /api/generate — returns both persisted messages. */
export interface GenerateImageResponse {
  userMessage: GeneratedMessage;
  aiMessage: GeneratedMessage;
}

/** Body for POST /api/respond */
export interface GenerateTextBody {
  chatId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
}

/** Response for POST /api/respond — returns both persisted messages. */
export interface GenerateTextResponse {
  userMessage: GeneratedMessage;
  aiMessage: GeneratedMessage;
}

/** Represents a validated and configured API connector. */
export interface Connector extends Omit<
  SecretMetadataRow,
  'configured' | 'enabledModels' | 'provider'
> {
  provider: ProviderType;
  configured: boolean;
  enabledModels: string[];
  userId: string | null;
}

/** Current runtime-safe status for configured connectors. */
export interface ConnectorStatus {
  connectors: Connector[];
}

/** Body for POST /api/settings/connectors/gemini */
export interface AddConnectorBody {
  name: string;
  apiKey: string;
  source: SecretSource;
  provider?: ProviderType;
  baseUrl?: string;
  /** Optional OpenAI Organization ID — only sent for provider === 'openai'. */
  organizationId?: string;
  /** Optional OpenAI Project ID — only sent for provider === 'openai'. */
  projectId?: string;
}

/** Body for PUT /api/settings/connectors/gemini/:id/models */
export interface UpdateConnectorModelsBody {
  enabledModels: string[];
}

/** Response for DELETE /api/settings/connectors/gemini/:id */
export interface DeleteGeminiSecretResponse {
  success: true;
}

/** Runtime state of the cached model catalog. */
export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Provider capabilities for a model. */
export interface ModelCapabilities {
  text: boolean;
  image: boolean;
  streaming: boolean;
  reasoning?: boolean;
  tools?: boolean;
  statefulContinuation?: boolean;
  promptCaching?: boolean;
  parallelToolCalls?: boolean;
  reasoningWithTools?: boolean;
}

/** A UI-safe model option discovered from a provider. */
export interface ModelOption {
  modelId: string;
  resourceName: string;
  displayName: string;
  description?: string;
  version?: string;
  supportedActions: string[];
  provider?: ProviderType;
  capabilities?: ModelCapabilities;
  /** Maximum input tokens accepted by the model (from provider API). */
  inputTokenLimit?: number;
}

/** Cached model catalog returned by the API settings route. */
export interface ModelCatalogResponse {
  configured: boolean;
  status: ModelCatalogStatus;
  lastSyncedAt?: number;
  error?: string;
  allModels: ModelOption[];
  textModels: ModelOption[];
  imageModels: ModelOption[];
  discoveredTextModels: ModelOption[];
  discoveredImageModels: ModelOption[];
}

/** A persisted message returned by the generate or respond endpoint. */
export interface GeneratedMessage {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string;
  referenceImage?: string;
  timestamp: number;
  isGenerating: boolean;
  generationTime?: string;
  modelName?: string;
  styleParams?: string[];
  interactionMode?: InteractionMode;
  parts?: MessagePart[];
  providerState?: string;
}

/** Generic API error response. */
export interface ApiErrorResponse {
  error: string;
}

/** SSE event: context window usage info, emitted after each turn. */
export interface SSEContextEvent {
  type: 'context_info';
  estimatedInputTokens: number;
  contextLimit: number;
  estimatedUsageRatio: number;
  mode: 'stateful' | 'replay' | 'compacted' | 'degraded';
  severity: 'normal' | 'info' | 'warning' | 'danger' | 'critical';
}

/** SSE event: signals the start of a new thinking segment, emitted before the first
 *  thinking delta of each distinct reasoning block. */
export interface SSEThinkingStartEvent {
  type: 'thinking_start';
  done: false;
}

/** SSE event: fallback/degradation notice, emitted when continuation mode changes. */
export interface SSEFallbackEvent {
  type: 'fallback_notice';
  from: string;
  to: string;
  reason: string;
}

/** SSE event: system event timeline marker, persisted in message parts. */
export interface SSESystemEvent {
  type: 'system_event';
  event: string;
  detail?: string;
  done: boolean;
}

/** Body for POST /api/auth/sign-up/email */
export interface SignUpBody {
  name: string;
  email: string;
  password: string;
}

/** Body for POST /api/auth/sign-in/email */
export interface SignInBody {
  email: string;
  password: string;
}
