/**
 * API request/response contracts (DTOs).
 * These define the shape of data exchanged between frontend and API.
 */

import type { InteractionMode, SecretSource, SecretMetadataRow, ProviderType } from '../types/index';

/** Body for POST /api/chats */
export interface CreateChatBody {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
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

/** @deprecated Use ConnectorStatus instead. */
export type GeminiSecretStatus = ConnectorStatus;

/** Body for POST /api/settings/connectors/gemini */
export interface AddConnectorBody {
  name: string;
  apiKey: string;
  source: SecretSource;
  provider?: ProviderType;
  baseUrl?: string;
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

/** @deprecated Use ModelCatalogStatus instead. */
export type GeminiModelCatalogStatus = ModelCatalogStatus;

/** Provider capabilities for a model. */
export interface ModelCapabilities {
  text: boolean;
  image: boolean;
  streaming: boolean;
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
}

/** @deprecated Use ModelOption instead. */
export type GeminiModelOption = ModelOption;

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

/** @deprecated Use ModelCatalogResponse instead. */
export type GeminiModelCatalogResponse = ModelCatalogResponse;

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
}

/** Generic API success response. */
export interface ApiSuccessResponse {
  success: true;
}

/** Generic API error response. */
export interface ApiErrorResponse {
  error: string;
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

/** Standard auth error response */
export interface AuthErrorResponse {
  code?: string;
  message: string;
}
