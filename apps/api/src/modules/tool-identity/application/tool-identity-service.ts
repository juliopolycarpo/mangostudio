/**
 * Tool identity registry: user-chosen names, monograms, and avatar images for
 * the tools the product already knows about.
 *
 * Display-only by construction. Nothing here is read by generation, propagation,
 * or any provider payload — the wire id in the subject key stays the identity
 * every other subsystem uses, and a rename only ever changes what a human reads.
 */

import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import {
  normalizeMonogram,
  type ToolIdentity,
  type ToolIdentityListResponse,
  type ToolIdentityUpdate,
} from '@mangostudio/shared/tool-identity';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import type { SafeFetchDeps } from '../../../lib/safe-fetch';
import { publishSettingsInvalidation } from '../../../services/realtime/settings-invalidation';
import { computeHash } from '../../../utils/hash';
import {
  deleteToolIdentityRow,
  getToolIdentityRow,
  listToolIdentityRows,
  type ToolIdentityFields,
  type ToolImageFields,
  toToolIdentity,
  upsertToolIdentityRow,
} from '../infrastructure/tool-identity-repository';
import { deleteToolImage, readToolImage } from '../infrastructure/tool-image-storage';
import {
  type PreparedToolImage,
  resolveToolImageFields,
  storeUploadedToolImage,
} from './tool-image-service';
import { assertOwnedMcpSubject, parseKnownSubject } from './tool-subject';

export async function listToolIdentities(
  db: Kysely<Database>,
  userId: string
): Promise<ToolIdentityListResponse> {
  const rows = await listToolIdentityRows(db, userId, DEFAULT_PROFILE_ID);
  return {
    identities: Object.fromEntries(rows.map((row) => [row.subjectKey, toToolIdentity(row)])),
  };
}

/**
 * Merges a patch onto the current row under a short database transaction.
 *
 * @example await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'Claude' });
 *
 * An absent field keeps what is stored; an explicit `null` resets that field to
 * its derived default. A patch that resets every field deletes the row instead
 * of storing a row of nulls, so "no customization" has exactly one
 * representation.
 */
export async function updateToolIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  patch: ToolIdentityUpdate,
  /** Outbound fetch seam for cached images; injected by tests, never by routes. */
  fetchDeps: Partial<SafeFetchDeps> = {}
): Promise<ToolIdentity | null> {
  const subject = parseKnownSubject(subjectKey);

  if (patch.image?.cache) {
    // Reuse is decided against the row being changed, not a pre-fetch snapshot.
    const reused = await writeIdentity(db, userId, subjectKey, patch, undefined, patch.image.url);
    if (reused) return finishIdentityWrite(userId, reused);
    // A cached URL can cause network I/O, so ownership must be checked first.
    await assertOwnedMcpSubject(db, userId, subject);
  }

  const image =
    patch.image === undefined
      ? undefined
      : await resolveToolImageFields(patch.image, userId, fetchDeps);
  return writeIdentityWithImage(userId, image, () =>
    writeIdentity(db, userId, subjectKey, patch, image?.fields)
  );
}

/**
 * Replaces the identity's image with an uploaded file, leaving its name and
 * monogram alone. Multipart, so it cannot ride on the JSON update route.
 *
 * @example await uploadToolIdentityImage(db, userId, 'agent:claude', file);
 */
export async function uploadToolIdentityImage(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  file: File
): Promise<ToolIdentity> {
  const subject = parseKnownSubject(subjectKey);
  await assertOwnedMcpSubject(db, userId, subject);

  const image = await storeUploadedToolImage(file, userId);
  const identity = await writeIdentityWithImage(userId, image, () =>
    writeIdentity(db, userId, subjectKey, {}, image.fields)
  );
  if (identity === null)
    throw new Error('(tool image upload): expected a stored identity | received: null');
  return identity;
}

/**
 * Writes the row, then settles what the change owes the filesystem.
 *
 * The row is the record of which file an identity owns, so it is what decides
 * which file is now garbage. Deleting first would mean a failed write — a busy
 * database is enough — leaves the identity pointing at an avatar that no longer
 * exists, and that loss is not recoverable.
 */
async function writeIdentityWithImage(
  userId: string,
  image: PreparedToolImage | undefined,
  write: () => Promise<ToolIdentityMutation>
): Promise<ToolIdentity | null> {
  let written: ToolIdentityMutation;
  try {
    written = await write();
  } catch (error) {
    await image?.rollback();
    throw error;
  }

  return finishIdentityWrite(userId, written);
}

interface ToolIdentityMutation {
  readonly identity: ToolIdentity | null;
  readonly replacedImagePath: string | null;
}

async function finishIdentityWrite(
  userId: string,
  written: ToolIdentityMutation
): Promise<ToolIdentity | null> {
  await deleteToolImage(written.replacedImagePath);
  publishSettingsInvalidation(userId, 'tool-identity');
  return written.identity;
}

export interface StoredToolImage {
  readonly body: Blob;
  /** Validated when the image was stored; never re-derived from the file. */
  readonly mimeType: string;
  /** Last customization update, independent of the immutable image identity. */
  readonly updatedAt: number;
  /** Opaque version of the stored bytes used by the image response ETag. */
  readonly cacheKey: string;
}

/**
 * The bytes behind an identity's avatar, when we hold any. A hotlinked URL has
 * none by definition — the browser fetches those itself.
 *
 * @example const image = await readToolIdentityImage(db, userId, subjectKey);
 */
export async function readToolIdentityImage(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string
): Promise<StoredToolImage | null> {
  parseKnownSubject(subjectKey);

  const row = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  if (!row?.imagePath || !row.imageMimeType) return null;

  const body = await readToolImage(row.imagePath);
  if (!body) return null;

  return {
    body,
    mimeType: row.imageMimeType,
    updatedAt: row.updatedAt,
    cacheKey: computeHash(row.imagePath),
  };
}

/**
 * Removes the current identity and releases the file that row actually owned.
 * @example await resetToolIdentity(db, userId, 'agent:claude');
 */
export async function resetToolIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string
): Promise<void> {
  parseKnownSubject(subjectKey);
  await writeIdentityWithImage(userId, undefined, () =>
    writeIdentity(
      db,
      userId,
      subjectKey,
      { displayName: null, monogram: null },
      {
        imageSource: null,
        imageUrl: null,
        imagePath: null,
        imageMimeType: null,
      }
    )
  );
}

/** Merge and write under the SQLite driver's transaction lock; never hold it for image I/O. */
function writeIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  patch: ToolIdentityUpdate,
  image?: ToolImageFields
): Promise<ToolIdentityMutation>;
function writeIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  patch: ToolIdentityUpdate,
  image: undefined,
  reuseImageUrl: string
): Promise<ToolIdentityMutation | undefined>;
async function writeIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  patch: ToolIdentityUpdate,
  image?: ToolImageFields,
  reuseImageUrl?: string
): Promise<ToolIdentityMutation | undefined> {
  return db.transaction().execute(async (transaction) => {
    const existing = await getToolIdentityRow(transaction, userId, DEFAULT_PROFILE_ID, subjectKey);
    if (
      reuseImageUrl !== undefined &&
      (!existing?.imagePath || existing.imageUrl !== reuseImageUrl)
    )
      return undefined;
    const fields: ToolIdentityFields = {
      displayName: resolveField(patch.displayName, existing?.displayName ?? null, (value) =>
        value.trim()
      ),
      monogram: resolveField(patch.monogram, existing?.monogram ?? null, normalizeMonogram),
      imageSource: existing?.imageSource ?? null,
      imageUrl: existing?.imageUrl ?? null,
      imagePath: existing?.imagePath ?? null,
      imageMimeType: existing?.imageMimeType ?? null,
      ...image,
    };
    let identity: ToolIdentity | null = null;
    if (fields.displayName === null && fields.monogram === null && fields.imageSource === null) {
      await deleteToolIdentityRow(transaction, userId, DEFAULT_PROFILE_ID, subjectKey);
    } else {
      await assertOwnedMcpSubject(transaction, userId, parseKnownSubject(subjectKey));
      const updatedAt = await upsertToolIdentityRow(
        transaction,
        userId,
        DEFAULT_PROFILE_ID,
        subjectKey,
        fields
      );
      identity = toToolIdentity({ subjectKey, updatedAt, ...fields });
    }
    return {
      identity,
      replacedImagePath:
        existing?.imagePath !== (identity === null ? null : fields.imagePath)
          ? (existing?.imagePath ?? null)
          : null,
    };
  });
}

/** Absent keeps the stored value; `null` resets it; a value is normalized. */
function resolveField(
  patched: string | null | undefined,
  stored: string | null,
  normalize: (value: string) => string
): string | null {
  if (patched === undefined) return stored;
  if (patched === null) return null;
  const normalized = normalize(patched);
  return normalized.length > 0 ? normalized : null;
}
