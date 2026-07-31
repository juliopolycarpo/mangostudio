import type { ToolIdentity, ToolImage, ToolImageSource } from '@mangostudio/shared/tool-identity';
import type { Kysely } from 'kysely';
import type { Database, ToolIdentitySelect } from '../../../db/types';
import { generateId } from '../../../utils/id';

/** The image half of a row, resolved before a write and always written whole. */
export interface ToolImageFields {
  readonly imageSource: string | null;
  readonly imageUrl: string | null;
  readonly imagePath: string | null;
  readonly imageMimeType: string | null;
}

export interface ToolIdentityFields extends ToolImageFields {
  readonly displayName: string | null;
  readonly monogram: string | null;
}

/**
 * Everything the wire shape is built from: a stored row, or the fields of one
 * that has just been written. A row carries bookkeeping columns the contract
 * has no use for, so the narrower shape is what the mapper asks for.
 */
export type ToolIdentityRecord = ToolIdentityFields & {
  readonly subjectKey: string;
  readonly updatedAt: number;
};

export function listToolIdentityRows(
  db: Kysely<Database>,
  userId: string,
  profileId: string
): Promise<ToolIdentitySelect[]> {
  return db
    .selectFrom('user_tool_identities')
    .selectAll()
    .where('userId', '=', userId)
    .where('profileId', '=', profileId)
    .execute();
}

export function getToolIdentityRow(
  db: Kysely<Database>,
  userId: string,
  profileId: string,
  subjectKey: string
): Promise<ToolIdentitySelect | undefined> {
  return db
    .selectFrom('user_tool_identities')
    .selectAll()
    .where('userId', '=', userId)
    .where('profileId', '=', profileId)
    .where('subjectKey', '=', subjectKey)
    .executeTakeFirst();
}

/**
 * Writes both fields every time. The service has already merged the patch onto
 * the stored row, so a partial update never reaches here as a partial write —
 * which is what keeps "field absent means leave it" and "field null means reset
 * it" from collapsing into each other.
 */
export async function upsertToolIdentityRow(
  db: Kysely<Database>,
  userId: string,
  profileId: string,
  subjectKey: string,
  fields: ToolIdentityFields
): Promise<number> {
  const now = Date.now();

  await db
    .insertInto('user_tool_identities')
    .values({
      id: generateId(),
      userId,
      profileId,
      subjectKey,
      ...fields,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'profileId', 'subjectKey']).doUpdateSet({ ...fields, updatedAt: now })
    )
    .execute();

  return now;
}

export async function deleteToolIdentityRow(
  db: Kysely<Database>,
  userId: string,
  profileId: string,
  subjectKey: string
): Promise<void> {
  await db
    .deleteFrom('user_tool_identities')
    .where('userId', '=', userId)
    .where('profileId', '=', profileId)
    .where('subjectKey', '=', subjectKey)
    .execute();
}

/** Row → wire shape. Storage columns and the contract are allowed to diverge. */
export function toToolIdentity(row: ToolIdentityRecord): ToolIdentity {
  return {
    subjectKey: row.subjectKey,
    displayName: row.displayName,
    monogram: row.monogram,
    image: toToolImage(row),
    updatedAt: row.updatedAt,
  };
}

/**
 * Four nullable columns collapse into the one question a client has to answer:
 * where do I load this from. `cached` is derived rather than stored so a row
 * cannot claim bytes it does not have — the file path is the only record of
 * whether the bytes exist.
 */
function toToolImage(row: ToolIdentityRecord): ToolImage | null {
  if (!isToolImageSource(row.imageSource)) return null;

  return { source: row.imageSource, url: row.imageUrl, cached: row.imagePath !== null };
}

function isToolImageSource(value: string | null): value is ToolImageSource {
  return value === 'upload' || value === 'url';
}
