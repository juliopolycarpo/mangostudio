/** Represents the current input composer mode. */
export type InteractionMode = 'chat' | 'image';

/** Supported AI provider types. */
export type ProviderType = 'gemini' | 'openai' | 'openai-compatible' | 'anthropic';

/** Represents the source of a configured provider secret. */
export type SecretSource = 'bun-secrets' | 'environment' | 'config-file' | 'none';

/** Effort level for reasoning models. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

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
  enabledModels: string;
  userId: string | null;
  baseUrl: string | null;
  /** Optional OpenAI Organization ID (only meaningful for provider === 'openai'). */
  organizationId?: string | null;
  /** Optional OpenAI Project ID (only meaningful for provider === 'openai'). */
  projectId?: string | null;
}
