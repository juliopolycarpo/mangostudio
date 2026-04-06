/**
 * Shared domain types used across frontend and API.
 */

/** Represents the current input composer mode. */
export type InteractionMode = 'chat' | 'image';

/** Supported AI provider types. */
export type ProviderType = 'gemini' | 'openai' | 'openai-compatible' | 'anthropic';

/** Represents the source of a configured provider secret. */
export type SecretSource = 'bun-secrets' | 'environment' | 'config-file' | 'none';

/** Represents a chat session. */
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** @deprecated Use textModel or imageModel instead. */
  model?: string;
  textModel?: string;
  imageModel?: string;
  lastUsedMode?: InteractionMode;
}

/** Represents a message within a chat. */
export interface Message {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string; // kept for backward compat — derived from text parts
  interactionMode?: InteractionMode;
  imageUrl?: string;
  referenceImage?: string;
  timestamp: Date;
  styleParams?: string[];
  generationTime?: string;
  isGenerating?: boolean;
  modelName?: string;
  parts?: MessagePart[]; // source of truth for structured messages
  providerState?: string; // opaque JSON for provider continuity
}

/** Effort level for reasoning models. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** A single event emitted during an agentic turn (streaming tool loop). */
export type AgentEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_started'; callId: string; name?: string }
  | { type: 'tool_call_arguments_delta'; callId: string; delta: string }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError?: boolean }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'turn_completed'; providerState?: string; finishReason?: string }
  | { type: 'turn_error'; error: string }
  | { type: 'continuation_degraded'; from: string; to: string; reason: string };

/** Discriminated union of all content block types in an assistant message. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'error'; text: string }
  | { type: 'system_event'; event: string; detail?: string };

/** Database row shape for secret metadata tracked in SQLite. */
export interface SecretMetadataRow {
  id: string;
  name: string;
  provider: string;
  configured: number;
  source: SecretSource;
  maskedSuffix: string | null;
  updatedAt: number;
  lastValidatedAt: number | null;
  lastValidationError: string | null;
  enabledModels: string; // JSON string array
  userId: string | null;
  baseUrl: string | null;
  /** Optional OpenAI Organization ID (only meaningful for provider === 'openai'). */
  organizationId?: string | null;
  /** Optional OpenAI Project ID (only meaningful for provider === 'openai'). */
  projectId?: string | null;
}

/** Gallery item used for displaying images across chats. */
export interface GalleryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  chatId: string;
}

/** Authenticated user info returned by session. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string;
}

/** Active session info. */
export interface AuthSession {
  user: AuthUser;
  token: string;
  expiresAt: number;
}
