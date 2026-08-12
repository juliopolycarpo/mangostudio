/**
 * Shared domain types used across frontend and API.
 * This barrel re-exports all types from bounded-context submodules.
 */

// Auth types — source of truth is auth/contracts.ts
export type { AuthSession, AuthUser } from '../auth/contracts';
// Chat domain types — source of truth is chat/schemas.ts and chat/entities.ts
export type { Message } from '../chat/entities';
export type { Chat } from '../chat/schemas';
export type { TurnCheckpointPart } from '../turn-recovery';
export type {
  AgentEvent,
  ContinuationReasonCode,
  ExternalActivityPart,
  ExternalApprovalPart,
  ExternalSteerPart,
  ExternalTurnPart,
  GeneratedImagePart,
  GeneratedImageStatus,
  McpElicitationPart,
  McpMediaPart,
  MessagePart,
  QuestionPart,
  SubagentTraceEvent,
  SubagentTraceEventName,
  SubagentTracePart,
  TodoPart,
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
