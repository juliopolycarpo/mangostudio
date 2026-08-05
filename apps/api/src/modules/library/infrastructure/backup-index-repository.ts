/**
 * Hub-side listing index for backup sets that live on the runtime machines.
 *
 * Library backups deliberately stay on the machine that owned the file, which
 * makes "read every manifest" a listing that only works for machines the hub can
 * reach. An offline environment's backups would simply vanish from the page,
 * which is the opposite of what "restore needs that environment online" is meant
 * to teach. These rows are what keeps them visible.
 *
 * The index says *that* a set exists. The manifest on the machine says what is
 * in it and is the only thing a restore ever reads — a row is never allowed to
 * become the source of truth for content.
 */

import type { BackupSetOperation } from '@mangostudio/shared/library';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type { Database, LibraryBackupInsert, LibraryBackupSelect } from '../../../db/types';
import { generateId } from '../../../utils/id';

export interface LibraryBackupIndexRow {
  readonly environmentId: string;
  readonly backupId: string;
  readonly createdAtMs: number;
  readonly sizeBytes: number;
  readonly pinned: boolean;
  readonly operation: BackupSetOperation;
}

export interface LibraryBackupIndex {
  list(userId: string): Promise<LibraryBackupIndexRow[]>;
  /** Inserts or refreshes rows. Identity is user + environment + backup id. */
  record(userId: string, rows: readonly LibraryBackupIndexRow[]): Promise<void>;
  /**
   * Drops rows for sets a machine no longer has.
   *
   * There is deliberately no "forget this whole environment" here: deleting an
   * environment removes its rows inside the same transaction that removes the
   * environment (`environment-repository.ts`), so the cache can never outlive
   * the machine it describes.
   */
  forget(userId: string, environmentId: string, backupIds: readonly string[]): Promise<void>;
}

/**
 * An unrecognized operation reads as `unknown` rather than being dropped.
 *
 * The column is written from a manifest field that is itself allowed to be
 * absent, and a row whose bytes exist is worth listing even when it cannot say
 * which flow wrote it — `unknown` is exactly the label the UI already renders
 * for a v1 manifest.
 */
function toOperation(value: string): BackupSetOperation {
  return value === 'propagation' || value === 'removal' ? value : 'unknown';
}

function toRow(row: LibraryBackupSelect): LibraryBackupIndexRow {
  return {
    environmentId: row.environmentId,
    backupId: row.backupId,
    createdAtMs: row.createdAtMs,
    sizeBytes: row.sizeBytes,
    pinned: row.pinned === 1,
    operation: toOperation(row.operation),
  };
}

export function createLibraryBackupIndex(db: Kysely<Database> = getDb()): LibraryBackupIndex {
  return {
    async list(userId) {
      const rows = await db
        .selectFrom('library_backups')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('createdAtMs', 'desc')
        .orderBy('backupId', 'desc')
        .execute();
      return rows.map(toRow);
    },

    async record(userId, rows) {
      if (rows.length === 0) return;
      const values: LibraryBackupInsert[] = rows.map((row) => ({
        id: generateId(),
        userId,
        environmentId: row.environmentId,
        backupId: row.backupId,
        createdAtMs: row.createdAtMs,
        sizeBytes: row.sizeBytes,
        pinned: row.pinned ? 1 : 0,
        operation: row.operation,
      }));
      await db
        .insertInto('library_backups')
        .values(values)
        // Re-recording is how a listing reconciles: the machine has just been
        // asked, so its numbers replace whatever this row last believed. The id
        // column is deliberately left alone — a row's identity is the triple.
        .onConflict((conflict) =>
          conflict.columns(['userId', 'environmentId', 'backupId']).doUpdateSet((eb) => ({
            createdAtMs: eb.ref('excluded.createdAtMs'),
            sizeBytes: eb.ref('excluded.sizeBytes'),
            pinned: eb.ref('excluded.pinned'),
            operation: eb.ref('excluded.operation'),
          }))
        )
        .execute();
    },

    async forget(userId, environmentId, backupIds) {
      if (backupIds.length === 0) return;
      await db
        .deleteFrom('library_backups')
        .where('userId', '=', userId)
        .where('environmentId', '=', environmentId)
        .where('backupId', 'in', [...backupIds])
        .execute();
    },
  };
}
