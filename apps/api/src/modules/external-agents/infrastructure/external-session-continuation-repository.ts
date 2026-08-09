/**
 * The server-owned half of an external chat: which vendor session it resumes.
 *
 * A chat's runner is user-set and lives on `chats`; the native session handle,
 * the runtime session, the canonical workspace and the vendor account are not,
 * and live here. No client request reaches this table — every writer is a
 * server-side decision about a session it just opened.
 *
 * A native session is only valid for one
 * `(user, environment, target, canonical workspace, vendor account)` tuple,
 * which is why each of those is a column: resuming across any change would hand
 * one binding's conversation to another's.
 */

import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import { ExternalAgentConfigurationSchema } from '@mangostudio/shared/external-agents';
import { Value } from '@sinclair/typebox/value';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';

/** The tuple a stored continuation is only valid for. */
export interface ExternalContinuationBinding {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: string;
  readonly canonicalWorkspacePath: string;
  /** Absent when the adapter reported no account identity to compare. */
  readonly vendorAccountFingerprint: string | null;
}

export interface ExternalSessionContinuation extends ExternalContinuationBinding {
  readonly chatId: string;
  readonly runtimeSessionId: string;
  readonly nativeSessionId: string;
  readonly effectiveConfiguration: ExternalAgentConfiguration | null;
  readonly updatedAt: number;
}

export async function readContinuation(
  chatId: string,
  db: Kysely<Database>
): Promise<ExternalSessionContinuation | undefined> {
  const row = await db
    .selectFrom('external_session_continuations')
    .selectAll()
    .where('chatId', '=', chatId)
    .executeTakeFirst();
  if (!row) return undefined;

  return {
    chatId: row.chatId,
    userId: row.userId,
    environmentId: row.environmentId,
    targetId: row.targetId,
    canonicalWorkspacePath: row.canonicalWorkspacePath,
    vendorAccountFingerprint: row.vendorAccountFingerprint,
    runtimeSessionId: row.runtimeSessionId,
    nativeSessionId: row.nativeSessionId,
    effectiveConfiguration: parseEffectiveConfiguration(row.effectiveConfiguration),
    updatedAt: row.updatedAt,
  };
}

export interface WriteContinuationInput extends ExternalContinuationBinding {
  readonly chatId: string;
  readonly runtimeSessionId: string;
  readonly nativeSessionId: string;
  readonly effectiveConfiguration: ExternalAgentConfiguration | null;
  readonly updatedAt: number;
}

/**
 * Upserts on the `chatId` primary key. The single-flight in the session manager
 * keeps two sends from racing here in the first place; this is what makes a
 * second vendor session impossible rather than unlikely, because a chat has at
 * most one row and the last writer's session is the one anything resumes.
 */
export async function writeContinuation(
  input: WriteContinuationInput,
  db: Kysely<Database>
): Promise<void> {
  const values = {
    chatId: input.chatId,
    userId: input.userId,
    environmentId: input.environmentId,
    targetId: input.targetId,
    canonicalWorkspacePath: input.canonicalWorkspacePath,
    vendorAccountFingerprint: input.vendorAccountFingerprint,
    runtimeSessionId: input.runtimeSessionId,
    nativeSessionId: input.nativeSessionId,
    effectiveConfiguration: input.effectiveConfiguration
      ? JSON.stringify(input.effectiveConfiguration)
      : null,
    updatedAt: input.updatedAt,
  };

  await db
    .insertInto('external_session_continuations')
    .values(values)
    .onConflict((conflict) => conflict.column('chatId').doUpdateSet(values))
    .execute();
}

export async function deleteContinuation(chatId: string, db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('external_session_continuations').where('chatId', '=', chatId).execute();
}

/**
 * Whether a stored continuation may still be resumed.
 *
 * Permission level and approval routing are deliberately *not* part of the
 * tuple: Codex accepts them per turn and Cursor's session mode applies to a
 * live session, so restarting on a permission change would be a regression
 * rather than a safeguard.
 */
export function continuationMatches(
  continuation: ExternalContinuationBinding,
  binding: ExternalContinuationBinding
): boolean {
  return (
    continuation.userId === binding.userId &&
    continuation.environmentId === binding.environmentId &&
    continuation.targetId === binding.targetId &&
    continuation.canonicalWorkspacePath === binding.canonicalWorkspacePath &&
    continuation.vendorAccountFingerprint === binding.vendorAccountFingerprint
  );
}

/**
 * The stored configuration is display-only and vendor-reported, so a row written
 * by a build with a different shape is dropped rather than trusted.
 */
function parseEffectiveConfiguration(raw: string | null): ExternalAgentConfiguration | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Value.Check(ExternalAgentConfigurationSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}
