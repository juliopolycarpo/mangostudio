/**
 * Shared domain types used across frontend and API.
 * This barrel re-exports all types from bounded-context submodules.
 */

export type {
  InteractionMode,
  ProviderType,
  SecretSource,
  ReasoningEffort,
  SecretMetadataRow,
} from './provider';
export type { AgentEvent, MessagePart, ContinuationReasonCode } from './agent-events';
export type { GalleryItem, GeneratedImageArtifact } from './gallery';

// Chat domain types — source of truth is chat/entities.ts
export type { Chat, Message } from '../chat/entities';

// Auth types — source of truth is auth/contracts.ts
export type { AuthUser, AuthSession } from '../auth/contracts';
