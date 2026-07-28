/**
 * Kysely database types for the MangoStudio SQLite schema.
 */

import type { InteractionMode } from '@mangostudio/shared';
import type { ChatAttachmentKind } from '@mangostudio/shared/chat';
import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

interface ChatsTable {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  lastUsedMode: string | null;
  selectedAgentId: string | null;
  workdir: string | null;
  /** null = inherit workspace default; 0/1 stored as boolean override */
  restrictToolsToWorkdir: number | null;
  userId: string | null;
  lastProviderState: string | null;
  lastContextState: string | null;
}

interface MessagesTable {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  isGenerating: number;
  generationTime: string | null;
  modelName: string | null;
  styleParams: string | null;
  interactionMode: InteractionMode;
  parts: string | null; // JSON-serialized MessagePart[]
  providerState: string | null; // opaque provider continuity JSON
}

interface GeneratedImagesTable {
  id: string;
  userId: string;
  chatId: string;
  messageId: string;
  toolCallId: string | null;
  prompt: string;
  imageUrl: string;
  modelName: string | null;
  generationTime: string | null;
  createdAt: number;
  metadataJson: string | null;
}

interface ChatAttachmentsTable {
  id: string;
  userId: string;
  chatId: string;
  messageId: string | null;
  originalName: string;
  storedName: string;
  relativePath: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  createdAt: number;
  updatedAt: number;
}

interface SecretMetadataTable {
  id: string;
  name: string;
  provider: string;
  configured: number;
  source: 'bun-secrets' | 'environment' | 'config-file' | 'none';
  maskedSuffix: string | null;
  updatedAt: number;
  lastValidatedAt: number | null;
  lastValidationError: string | null;
  enabledModels: string;
  userId: string | null;
  baseUrl: string | null;
  /** Optional OpenAI Organization ID (only meaningful for provider === 'openai'). */
  organizationId: string | null;
  /** Optional OpenAI Project ID (only meaningful for provider === 'openai'). */
  projectId: string | null;
}

interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionTable {
  id: string;
  expiresAt: number;
  token: string;
  createdAt: number;
  updatedAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

interface AccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
  password: string | null;
  createdAt: number;
  updatedAt: number;
}

interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

interface UserProviderSettingsTable {
  id: string;
  userId: string;
  provider: string;
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

interface UserToolSettingsTable {
  id: string;
  userId: string;
  toolName: string;
  enabled: number;
  parametersJson: string;
  createdAt: number;
  updatedAt: number;
}

interface UserSkillSettingsTable {
  id: string;
  userId: string;
  /** Stable `<source>:<slug>` skill identity. */
  skillKey: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

interface UserAppSettingsTable {
  id: string;
  userId: string;
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

interface UserAgentSettingsTable {
  id: string;
  userId: string;
  agentId: string;
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

interface ConnectorUsageSamplesTable {
  id: string;
  /** ChatGPT account id — usage windows are account-scoped, not connector-scoped. */
  accountId: string;
  window: 'primary' | 'secondary';
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
  sampledAt: number;
}

interface McpServersTable {
  id: string;
  userId: string;
  /** Display name. */
  name: string;
  /** Per-user unique identifier; becomes the tool namespace prefix. */
  slug: string;
  transport: 'stdio' | 'http';
  /** stdio transport only. */
  command: string | null;
  argsJson: string; // JSON-serialized string[]
  /** Non-secret stdio child env; JSON-serialized Record<string, string>. */
  envJson: string;
  /** http transport only. */
  url: string | null;
  enabled: number;
  /** Per-request cap in ms; null falls back to the built-in default. */
  timeoutMs: number | null;
  createdAt: number;
  updatedAt: number;
}

interface FileCheckpointsTable {
  /** Rowid alias assigned by SQLite; ascending id is the message's mutation order. */
  id: Generated<number>;
  chatId: string;
  messageId: string;
  path: string;
  op: string;
  beforeHash: string | null;
  afterHash: string | null;
  movedTo: string | null;
  blobKey: string | null;
  createdAt: number;
  revertedAt: number | null;
}

interface EnvironmentInstallRunsTable {
  id: string;
  userId: string;
  /** Reserved profile scope; always `default` until profiles ship. */
  profileId: string;
  recipeId: string;
  /** JSON-serialized string[]. */
  argvJson: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  status: string;
  truncated: number;
}

interface LibraryDivergenceAcksTable {
  id: string;
  userId: string;
  /** Reserved profile scope; always `default` until profiles ship. */
  profileId: string;
  /** `<kind>:<slug>` — one acknowledgement per resource per user+profile. */
  resourceKey: string;
  /** Digest of the accepted hash set; a content change retires the row. */
  divergenceKey: string;
  /** JSON-serialized string[]. */
  contentHashesJson: string;
  acknowledgedAt: number;
}

interface ChatTodosTable {
  /** One row per chat; the list is always replaced wholesale. */
  chatId: string;
  userId: string;
  /** JSON-serialized TodoItem[]. */
  items: string;
  updatedAt: number;
}

interface ObservabilitySnapshotTable {
  id: string;
  snapshotJson: string;
  updatedAt: number;
}

/** Root Kysely Database interface. */
export interface Database {
  chats: ChatsTable;
  messages: MessagesTable;
  generated_images: GeneratedImagesTable;
  chat_attachments: ChatAttachmentsTable;
  secret_metadata: SecretMetadataTable;
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  user_provider_settings: UserProviderSettingsTable;
  user_tool_settings: UserToolSettingsTable;
  user_skill_settings: UserSkillSettingsTable;
  user_app_settings: UserAppSettingsTable;
  user_agent_settings: UserAgentSettingsTable;
  mcp_servers: McpServersTable;
  chat_todos: ChatTodosTable;
  file_checkpoints: FileCheckpointsTable;
  environment_install_runs: EnvironmentInstallRunsTable;
  library_divergence_acks: LibraryDivergenceAcksTable;
  observability_snapshot: ObservabilitySnapshotTable;
  connector_usage_samples: ConnectorUsageSamplesTable;
}

export type GeneratedImageSelect = Selectable<GeneratedImagesTable>;

export type ChatAttachmentSelect = Selectable<ChatAttachmentsTable>;
export type ChatAttachmentInsert = Insertable<ChatAttachmentsTable>;

export type UserProviderSettingsSelect = Selectable<UserProviderSettingsTable>;

export type UserToolSettingsSelect = Selectable<UserToolSettingsTable>;

export type UserAppSettingsSelect = Selectable<UserAppSettingsTable>;

export type UserAgentSettingsSelect = Selectable<UserAgentSettingsTable>;

export type McpServerSelect = Selectable<McpServersTable>;
export type McpServerInsert = Insertable<McpServersTable>;
export type McpServerUpdate = Updateable<McpServersTable>;

export type ChatTodoSelect = Selectable<ChatTodosTable>;
export type ChatTodoInsert = Insertable<ChatTodosTable>;

export type FileCheckpointSelect = Selectable<FileCheckpointsTable>;
export type FileCheckpointInsert = Insertable<FileCheckpointsTable>;

export type EnvironmentInstallRunSelect = Selectable<EnvironmentInstallRunsTable>;
export type EnvironmentInstallRunInsert = Insertable<EnvironmentInstallRunsTable>;

export type LibraryDivergenceAckSelect = Selectable<LibraryDivergenceAcksTable>;
export type LibraryDivergenceAckInsert = Insertable<LibraryDivergenceAcksTable>;
