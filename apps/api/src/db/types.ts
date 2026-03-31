/**
 * Kysely database types for the MangoStudio SQLite schema.
 */

import type { Insertable, Selectable, Updateable } from 'kysely';

export interface ChatsTable {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  lastUsedMode: string | null;
  userId: string | null;
}

export interface MessagesTable {
  id: string;
  chatId: string;
  role: string;
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  isGenerating: number;
  generationTime: string | null;
  modelName: string | null;
  styleParams: string | null;
  interactionMode: string;
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

/** Root Kysely Database interface. */
export interface Database {
  chats: ChatsTable;
  messages: MessagesTable;
  secret_metadata: SecretMetadataTable;
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
}

export type ChatSelect = Selectable<ChatsTable>;
export type ChatInsert = Insertable<ChatsTable>;
export type ChatUpdate = Updateable<ChatsTable>;

export type MessageSelect = Selectable<MessagesTable>;
export type MessageInsert = Insertable<MessagesTable>;
export type MessageUpdate = Updateable<MessagesTable>;

export type SecretMetadataSelect = Selectable<SecretMetadataTable>;
export type SecretMetadataInsert = Insertable<SecretMetadataTable>;
export type SecretMetadataUpdate = Updateable<SecretMetadataTable>;

export type UserSelect = Selectable<UserTable>;
export type UserInsert = Insertable<UserTable>;
export type UserUpdate = Updateable<UserTable>;

export type SessionSelect = Selectable<SessionTable>;
export type SessionInsert = Insertable<SessionTable>;
export type SessionUpdate = Updateable<SessionTable>;

export type AccountSelect = Selectable<AccountTable>;
export type AccountInsert = Insertable<AccountTable>;
export type AccountUpdate = Updateable<AccountTable>;

export type VerificationSelect = Selectable<VerificationTable>;
export type VerificationInsert = Insertable<VerificationTable>;
export type VerificationUpdate = Updateable<VerificationTable>;
