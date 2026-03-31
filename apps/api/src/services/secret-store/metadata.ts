/**
 * SQLite-backed metadata helpers for secret status shown in Settings.
 */

import type { SecretMetadataRow, SecretSource } from '@mangostudio/shared/types';
import { getDb } from '../../db/database';

/** Supported provider key for Gemini secret metadata. */
export const GEMINI_PROVIDER = 'gemini' as const;

/** Shape used when upserting provider metadata. */
export interface SecretMetadataInput {
  id: string;
  name: string;
  provider: string;
  configured: boolean;
  source: SecretSource;
  maskedSuffix?: string | null;
  updatedAt: number;
  lastValidatedAt?: number | null;
  lastValidationError?: string | null;
  enabledModels: string[];
  userId: string | null;
  baseUrl?: string | null;
  /** Optional OpenAI Organization ID. */
  organizationId?: string | null;
  /** Optional OpenAI Project ID. */
  projectId?: string | null;
}

/**
 * Loads all metadata records for a provider.
 *
 * Returns an empty array when the DB is not yet fully initialised (e.g. in
 * test workers that only partially mock the database module), preventing a
 * TypeError from bubbling up through syncConfigFileConnectors during stream
 * handler execution.
 *
 * @param provider - Provider identifier.
 * @param userId - User ID to filter by.
 * @returns List of stored connector metadata rows.
 */
export async function listSecretMetadata(
  provider: string,
  userId: string
): Promise<SecretMetadataRow[]> {
  try {
    const db = getDb();
    return await db
      .selectFrom('secret_metadata')
      .selectAll()
      .where('provider', '=', provider)
      .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
      .execute();
  } catch (err) {
    if (err instanceof TypeError) return [];
    throw err;
  }
}

/**
 * Loads all metadata records across all providers for a user.
 */
export async function listAllSecretMetadata(userId: string): Promise<SecretMetadataRow[]> {
  const db = getDb();
  return db
    .selectFrom('secret_metadata')
    .selectAll()
    .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
    .execute();
}

/**
 * Loads metadata for a specific connector ID.
 *
 * @param id - Connector unique identifier.
 * @param userId - User ID.
 * @returns The stored metadata row or null.
 */
export async function getSecretMetadataById(
  id: string,
  userId: string
): Promise<SecretMetadataRow | null> {
  const db = getDb();
  const row = await db
    .selectFrom('secret_metadata')
    .selectAll()
    .where('id', '=', id)
    .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Upserts UI-safe metadata for a provider-backed secret.
 *
 * @param input - Metadata payload to persist.
 */
export async function upsertSecretMetadata(input: SecretMetadataInput): Promise<void> {
  const db = getDb();
  await db
    .insertInto('secret_metadata')
    .values({
      id: input.id,
      name: input.name,
      provider: input.provider,
      configured: input.configured ? 1 : 0,
      source: input.source,
      maskedSuffix: input.maskedSuffix ?? null,
      updatedAt: input.updatedAt,
      lastValidatedAt: input.lastValidatedAt ?? null,
      lastValidationError: input.lastValidationError ?? null,
      enabledModels: JSON.stringify(input.enabledModels),
      userId: input.userId,
      baseUrl: input.baseUrl ?? null,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        name: input.name,
        configured: input.configured ? 1 : 0,
        source: input.source,
        maskedSuffix: input.maskedSuffix ?? null,
        updatedAt: input.updatedAt,
        lastValidatedAt: input.lastValidatedAt ?? null,
        lastValidationError: input.lastValidationError ?? null,
        enabledModels: JSON.stringify(input.enabledModels),
        userId: input.userId,
        baseUrl: input.baseUrl ?? null,
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
      })
    )
    .execute();
}

/**
 * Deletes a connector metadata record.
 *
 * @param id - Connector unique identifier.
 * @param userId - User ID.
 */
export async function deleteSecretMetadata(id: string, userId: string): Promise<void> {
  const db = getDb();
  await db
    .deleteFrom('secret_metadata')
    .where('id', '=', id)
    .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
    .execute();
}
