/**
 * Tool identity registry: user-chosen names and monograms for the tools the
 * product already knows about.
 *
 * Display-only by construction. Nothing here is read by generation, propagation,
 * or any provider payload — the wire id in the subject key stays the identity
 * every other subsystem uses, and a rename only ever changes what a human reads.
 */

import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import {
  normalizeMonogram,
  type ParsedSubjectKey,
  parseSubjectKey,
  type ToolIdentity,
  type ToolIdentityListResponse,
  type ToolIdentityUpdate,
} from '@mangostudio/shared/tool-identity';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { publishSettingsInvalidation } from '../../../services/realtime/settings-invalidation';
import {
  deleteToolIdentityRow,
  getToolIdentityRow,
  listToolIdentityRows,
  toToolIdentity,
  upsertToolIdentityRow,
} from '../infrastructure/tool-identity-repository';

export class ToolIdentityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode
  ) {
    super(message);
    this.name = 'ToolIdentityError';
  }
}

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
 * its derived default. A patch that resets both fields deletes the row instead
 * of storing two nulls, so "no customization" has exactly one representation.
 */
export async function updateToolIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string,
  patch: ToolIdentityUpdate
): Promise<ToolIdentity | null> {
  const subject = parseKnownSubject(subjectKey);

  const existing = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  const displayName = resolveField(patch.displayName, existing?.displayName ?? null, (value) =>
    value.trim()
  );
  const monogram = resolveField(patch.monogram, existing?.monogram ?? null, normalizeMonogram);

  if (displayName === null && monogram === null) {
    await clearToolIdentity(db, userId, subjectKey);
    return null;
  }

  await assertOwnedMcpSubject(db, userId, subject);

  const updatedAt = await upsertToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey, {
    displayName,
    monogram,
  });
  publishSettingsInvalidation(userId, 'tool-identity');

  return { subjectKey, displayName, monogram, updatedAt };
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
  await clearToolIdentity(db, userId, subjectKey);
}

async function clearToolIdentity(
  db: Kysely<Database>,
  userId: string,
  subjectKey: string
): Promise<void> {
  await deleteToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, subjectKey);
  publishSettingsInvalidation(userId, 'tool-identity');
}

/**
 * Splits a subject key and rejects one whose kind or id the contract does not
 * know. Everything a write needs except MCP ownership, which only matters when
 * a row is about to be stored.
 */
function parseKnownSubject(subjectKey: string): ParsedSubjectKey {
  const subject = parseSubjectKey(subjectKey);
  if (!subject) {
    throw new ToolIdentityError(
      `Unknown tool subject "${subjectKey}".`,
      422,
      ERROR_CODES.VALIDATION
    );
  }
  return subject;
}

/**
 * An `mcp:` label may only be stored against one of the caller's own servers,
 * so a key cannot be used to probe another user's setup. Checked before a write
 * rather than on every operation — see `resetToolIdentity`.
 */
async function assertOwnedMcpSubject(
  db: Kysely<Database>,
  userId: string,
  subject: ParsedSubjectKey
): Promise<void> {
  if (subject.kind !== 'mcp') return;

  const server = await db
    .selectFrom('mcp_servers')
    .select('id')
    .where('userId', '=', userId)
    .where('slug', '=', subject.id)
    .executeTakeFirst();

  if (!server) {
    throw new ToolIdentityError(`Unknown MCP server "${subject.id}".`, 422, ERROR_CODES.VALIDATION);
  }
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
