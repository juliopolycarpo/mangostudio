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
}

/**
 * Loads all metadata records for a provider.
 *
 * @param provider - Provider identifier.
 * @param userId - User ID to filter by.
 * @returns List of stored connector metadata rows.
 */
export async function listSecretMetadata(
  provider: string,
  userId: string
): Promise<SecretMetadataRow[]> {
  const db = getDb();
  return db
    .selectFrom('secret_metadata')
    .selectAll()
    .where('provider', '=', provider)
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
export async function deleteSecretMetadata(id: string, userId: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .deleteFrom('secret_metadata')
    .where('id', '=', id)
    .where((eb) => eb.or([eb('userId', '=', userId), eb('userId', 'is', null)]))
    .executeTakeFirst();
  return (result?.numAffectedRows ?? 0n) > 0n;
}
