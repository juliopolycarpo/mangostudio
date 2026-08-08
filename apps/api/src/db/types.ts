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
  runnerKind: Generated<string>;
  runnerAgentId: string | null;
  runnerTargetId: string | null;
  workdir: string | null;
  environmentId: Generated<string>;
  /** null = inherit workspace default; 0/1 stored as boolean override */
  restrictToolsToWorkdir: number | null;
  userId: string | null;
  lastProviderState: string | null;
  lastContextState: string | null;
}

interface EnvironmentsTable {
  id: string;
  userId: string;
  name: string;
  transportKind: string;
  configJson: string;
  enabled: number;
  /** Whether install recipes may run on this machine. Off until someone says so. */
  allowInstalls: number;
  createdAt: number;
  updatedAt: number;
}

interface RuntimePairingTokensTable {
  /** Public selector half of the token; the secret half is only ever hashed. */
  id: string;
  userId: string;
  environmentId: string;
  /** SHA-256 hex digest of the secret half. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
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

// Better Auth's kysely adapter reports supportsDates: false for sqlite, so date
// fields are written as ISO strings (value.toISOString()), not integers, despite
// the migration declaring these columns integer. SQLite type affinity preserves
// the text either way. See 006_auth_tables.ts and 035_api_keys.ts.
interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionTable {
  id: string;
  expiresAt: string;
  token: string;
  createdAt: string;
  updatedAt: string;
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
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ApiKeyTable {
  id: string;
  configId: string;
  name: string | null;
  start: string | null;
  referenceId: string;
  prefix: string | null;
  key: string;
  refillInterval: number | null;
  refillAmount: number | null;
  lastRefillAt: string | null;
  enabled: number;
  rateLimitEnabled: number;
  rateLimitTimeWindow: number | null;
  rateLimitMax: number | null;
  requestCount: number;
  remaining: number | null;
  lastRequest: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: string | null;
  metadata: string | null;
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
  /** Environment whose runtime hosts the session; `local` for the hub itself. */
  environmentId: string;
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
  /** The environment whose filesystem these paths and hashes describe. */
  environmentId: string;
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

/**
 * Listing index for backup sets that physically live on the runtime machines.
 *
 * A cache with exactly one honest failure mode: a machine that wiped its store
 * leaves rows here that degrade to "unavailable" until the hub can ask it again.
 * It is never the restore source — that is always the manifest on the machine.
 */
interface LibraryBackupsTable {
  id: string;
  userId: string;
  environmentId: string;
  /** Store-local id; unique only together with `userId` and `environmentId`. */
  backupId: string;
  createdAtMs: number;
  sizeBytes: number;
  pinned: number;
  /** `propagation` | `removal` | `unknown`, mirroring the on-machine manifest. */
  operation: string;
}

interface UserToolIdentitiesTable {
  id: string;
  userId: string;
  /** Reserved profile scope; always `default` until profiles ship. */
  profileId: string;
  /** `<kind>:<id>` — one override per tool per user+profile. */
  subjectKey: string;
  /** Null falls back to the product name, never to blank. */
  displayName: string | null;
  /** Stored uppercased; null falls back to the name-derived monogram. */
  monogram: string | null;
  /** `upload` | `url`; null means the avatar draws its monogram. */
  imageSource: string | null;
  /** Remote address for an `url` image, kept even once the bytes are cached. */
  imageUrl: string | null;
  /** Stored bytes relative to the tool-image directory; null when hotlinked. */
  imagePath: string | null;
  /** Type validated on write and pinned on serve; never re-sniffed from disk. */
  imageMimeType: string | null;
  createdAt: number;
  updatedAt: number;
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
  environments: EnvironmentsTable;
  runtime_pairing_tokens: RuntimePairingTokensTable;
  messages: MessagesTable;
  generated_images: GeneratedImagesTable;
  chat_attachments: ChatAttachmentsTable;
  secret_metadata: SecretMetadataTable;
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  apikey: ApiKeyTable;
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
  library_backups: LibraryBackupsTable;
  user_tool_identities: UserToolIdentitiesTable;
  observability_snapshot: ObservabilitySnapshotTable;
  connector_usage_samples: ConnectorUsageSamplesTable;
}

export type GeneratedImageSelect = Selectable<GeneratedImagesTable>;

export type ChatAttachmentSelect = Selectable<ChatAttachmentsTable>;
export type ChatAttachmentInsert = Insertable<ChatAttachmentsTable>;

export type EnvironmentSelect = Selectable<EnvironmentsTable>;
export type EnvironmentInsert = Insertable<EnvironmentsTable>;
export type EnvironmentUpdate = Updateable<EnvironmentsTable>;

export type RuntimePairingTokenSelect = Selectable<RuntimePairingTokensTable>;
export type RuntimePairingTokenInsert = Insertable<RuntimePairingTokensTable>;
export type RuntimePairingTokenUpdate = Updateable<RuntimePairingTokensTable>;

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

export type LibraryBackupSelect = Selectable<LibraryBackupsTable>;
export type LibraryBackupInsert = Insertable<LibraryBackupsTable>;

export type ToolIdentitySelect = Selectable<UserToolIdentitiesTable>;
