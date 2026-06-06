/**
 * Kysely database types for the MangoStudio SQLite schema.
 */

import type { InteractionMode } from '@mangostudio/shared';
import type { ChatAttachmentKind } from '@mangostudio/shared/chat';
import type { Insertable, Selectable } from 'kysely';

export interface ChatsTable {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  lastUsedMode: string | null;
  selectedAgentId: string | null;
  userId: string | null;
  lastProviderState: string | null;
  lastContextState: string | null;
}

export interface MessagesTable {
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

export interface GeneratedImagesTable {
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

export interface ChatAttachmentsTable {
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

export interface SecretMetadataTable {
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

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionTable {
  id: string;
  expiresAt: number;
  token: string;
  createdAt: number;
  updatedAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface AccountTable {
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

export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserProviderSettingsTable {
  id: string;
  userId: string;
  provider: string;
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserToolSettingsTable {
  id: string;
  userId: string;
  toolName: string;
  enabled: number;
  parametersJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserAppSettingsTable {
  id: string;
  userId: string;
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserAgentSettingsTable {
  id: string;
  userId: string;
  agentId: string;
  settingsJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ObservabilitySnapshotTable {
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
  user_app_settings: UserAppSettingsTable;
  user_agent_settings: UserAgentSettingsTable;
  observability_snapshot: ObservabilitySnapshotTable;
}

export type GeneratedImageSelect = Selectable<GeneratedImagesTable>;

export type ChatAttachmentSelect = Selectable<ChatAttachmentsTable>;
export type ChatAttachmentInsert = Insertable<ChatAttachmentsTable>;

export type UserProviderSettingsSelect = Selectable<UserProviderSettingsTable>;

export type UserToolSettingsSelect = Selectable<UserToolSettingsTable>;

export type UserAppSettingsSelect = Selectable<UserAppSettingsTable>;

export type UserAgentSettingsSelect = Selectable<UserAgentSettingsTable>;
