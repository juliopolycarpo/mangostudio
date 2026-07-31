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
import type { Database, ToolIdentitySelect } from '../../../db/types';
import type { SafeFetchDeps } from '../../../lib/safe-fetch';
import { publishSettingsInvalidation } from '../../../services/realtime/settings-invalidation';
import {
  deleteToolIdentityRow,
  getToolIdentityRow,
  listToolIdentityRows,
  type ToolIdentityFields,
  toToolIdentity,
  upsertToolIdentityRow,
} from '../infrastructure/tool-identity-repository';
import { deleteToolImage, readToolImage } from '../infrastructure/tool-image-storage';
import {
  patchKeepsImage,
  type ResolvedToolImage,
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
 * Merges a patch onto the stored row and writes the result.
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

  const existing = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  const displayName = resolveField(patch.displayName, existing?.displayName ?? null, (value) =>
    value.trim()
  );
  const monogram = resolveField(patch.monogram, existing?.monogram ?? null, normalizeMonogram);

  // Answered before the image is resolved, because resolving one can mean
  // fetching it, and a patch that clears everything must not spend a request on
  // an image it is about to throw away.
  if (displayName === null && monogram === null && !patchKeepsImage(patch.image, existing)) {
    await clearToolIdentity(db, userId, subjectKey, existing);
    return null;
  }

  // Before the fetch, too: an `mcp:` key the caller does not own must not be
  // able to make the server reach out to an address of the caller's choosing.
  await assertOwnedMcpSubject(db, userId, subject);

  const image = await resolveToolImageFields(patch.image, existing, userId, fetchDeps);
  return writeIdentityWithImage(image, () =>
    writeIdentity(db, userId, subjectKey, { displayName, monogram, ...image.fields })
  );
}

/**
 * Replaces the identity's image with an uploaded file, leaving its name and
 * monogram alone. Multipart, so it cannot ride on the JSON update route.
 */
export async function uploadToolIdentityImage(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  file: File
): Promise<ToolIdentity> {
  const subject = parseKnownSubject(subjectKey);
  await assertOwnedMcpSubject(db, userId, subject);

  const existing = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  const image = await storeUploadedToolImage(file, existing, userId);

  return writeIdentityWithImage(image, () =>
    writeIdentity(db, userId, subjectKey, {
      displayName: existing?.displayName ?? null,
      monogram: existing?.monogram ?? null,
      ...image.fields,
    })
  );
}

/**
 * Writes the row, then settles what the change owes the filesystem.
 *
 * The row is the record of which file an identity owns, so it is what decides
 * which file is now garbage. Deleting first would mean a failed write — a busy
 * database is enough — leaves the identity pointing at an avatar that no longer
 * exists, and that loss is not recoverable.
 */
async function writeIdentityWithImage<T>(
  image: ResolvedToolImage,
  write: () => Promise<T>
): Promise<T> {
  let written: T;
  try {
    written = await write();
  } catch (error) {
    await image.rollback();
    throw error;
  }

  await image.commit();
  return written;
}

export interface StoredToolImage {
  readonly body: Blob;
  /** Validated when the image was stored; never re-derived from the file. */
  readonly mimeType: string;
  /** Cache-buster the client already knows, so a replaced image is not stale. */
  readonly updatedAt: number;
}

/**
 * The bytes behind an identity's avatar, when we hold any. A hotlinked URL has
 * none by definition — the browser fetches those itself.
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

  return { body, mimeType: row.imageMimeType, updatedAt: row.updatedAt };
}

export async function resetToolIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string
): Promise<void> {
  // Grammar and static membership only. Deleting an MCP server must not strand
  // its label: requiring the server to still exist would make the orphaned row
  // permanently unresettable, which is the opposite of what a reset is for.
  parseKnownSubject(subjectKey);
  const existing = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  await clearToolIdentity(db, userId, subjectKey, existing);
}

async function writeIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  fields: ToolIdentityFields
): Promise<ToolIdentity> {
  const updatedAt = await upsertToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey, fields);
  publishSettingsInvalidation(userId, 'tool-identity');

  return toToolIdentity({ subjectKey, updatedAt, ...fields });
}

/**
 * Drops the row and the file it owned. Stored images are keyed by the row, so
 * deleting one here is the whole of image cleanup — there is no orphan sweep
 * to run later.
 */
async function clearToolIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  existing: ToolIdentitySelect | undefined
): Promise<void> {
  await deleteToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  await deleteToolImage(existing?.imagePath ?? null);
  publishSettingsInvalidation(userId, 'tool-identity');
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
