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
  CreateChatBody,
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

// Auth
export type { SignUpBody, SignInBody } from '../auth/schemas';

// Streaming SSE events
export type {
  SSEContextEvent,
  SSEThinkingStartEvent,
  SSEFallbackEvent,
  SSESystemEvent,
} from '../streaming/events';

// Legacy alias (was exported from this file before split)
export type { DeleteConnectorResponse as DeleteGeminiSecretResponse } from '../connectors/contracts';
