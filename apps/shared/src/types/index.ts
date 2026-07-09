/**
 * Shared domain types used across frontend and API.
 * This barrel re-exports all types from bounded-context submodules.
 */

// Auth types — source of truth is auth/contracts.ts
export type { AuthSession, AuthUser } from '../auth/contracts';
// Chat domain types — source of truth is chat/entities.ts
export type { Chat, Message } from '../chat/entities';
export type {
  AgentEvent,
  ContinuationReasonCode,
  GeneratedImagePart,
  GeneratedImageStatus,
  McpMediaPart,
  MessagePart,
  QuestionPart,
  SubagentTraceEvent,
  SubagentTraceEventName,
  SubagentTracePart,
} from './agent-events';
export { mergeSubagentTraceEvents } from './agent-events';
export type { GalleryItem, GeneratedImageArtifact } from './gallery';
export type {
  InteractionMode,
  ProviderType,
  ReasoningEffort,
  SecretMetadataRow,
  SecretSource,
} from './provider';
