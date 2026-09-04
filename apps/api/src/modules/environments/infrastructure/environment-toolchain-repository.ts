/**
 * Which Node and Bun every process spawned on one environment runs with.
 *
 * Keyed on `(userId, environmentId)` with no foreign key on `environmentId`:
 * the Local environment is virtual and never has a row in `environments`, so
 * `local` is a sentinel key here exactly as it is for install runs.
 */

import type { ToolchainSelection } from '@mangostudio/shared/environments';
import { DEFAULT_TOOLCHAIN_SELECTION } from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type {
  Database,
  EnvironmentToolchainInsert,
  EnvironmentToolchainSelect,
  EnvironmentToolchainUpdate,
} from '../../../db/types';

export interface EnvironmentToolchainRepository {
  get(userId: string, environmentId: string): Promise<ToolchainSelection | null>;
  /**
   * Writes only the runtimes named in `patch`, leaving every other column as
   * it was found, and answers with the row as committed.
   *
   * The merge belongs here rather than in a caller because the Node and Bun
   * cards autosave independently: a read-modify-write above this line lets two
   * requests read the same row and each write back its own field, and the
   * later one silently reverts the earlier.
   *
   * @example await repository.upsert(userId, 'local', { bun: '/opt/bun/bin/bun' }, Date.now())
   */
  upsert(
    userId: string,
    environmentId: string,
    patch: Partial<ToolchainSelection>,
    updatedAt: number
  ): Promise<ToolchainSelection>;
  remove(userId: string, environmentId: string): Promise<void>;
}

function toToolchainSelection(row: EnvironmentToolchainSelect): ToolchainSelection {
  return { node: row.nodeSelection, bun: row.bunSelection };
}

/**
 * `injected` is resolved per call rather than defaulted at construction, for
 * the same reason as {@link createEnvironmentRepository}: the module-scope
 * singleton below is built at import time, so an eager `= getDb()` default
 * would open SQLite as a side effect of importing the app.
 */
export function createEnvironmentToolchainRepository(
  injected?: Kysely<Database>
): EnvironmentToolchainRepository {
  const db = (): Kysely<Database> => injected ?? getDb();

  return {
    async get(userId, environmentId) {
      const row = await db()
        .selectFrom('environment_toolchains')
        .selectAll()
        .where('userId', '=', userId)
        .where('environmentId', '=', environmentId)
        .executeTakeFirst();
      return row ? toToolchainSelection(row) : null;
    },

    async upsert(userId, environmentId, patch, updatedAt) {
      // A row that does not exist yet has no other field to preserve, so the
      // insert fills the absent runtimes with the same default `resolve`
      // reports for a missing row.
      const values: EnvironmentToolchainInsert = {
        userId,
        environmentId,
        nodeSelection: patch.node ?? DEFAULT_TOOLCHAIN_SELECTION.node,
        bunSelection: patch.bun ?? DEFAULT_TOOLCHAIN_SELECTION.bun,
        updatedAt,
      };
      // Only the named runtimes are assigned on conflict, so the statement
      // reads and writes the row once and never carries a stale value for the
      // runtime this request did not touch.
      const update: EnvironmentToolchainUpdate = {
        ...(patch.node !== undefined && { nodeSelection: patch.node }),
        ...(patch.bun !== undefined && { bunSelection: patch.bun }),
        updatedAt,
      };
      const row = await db()
        .insertInto('environment_toolchains')
        .values(values)
        .onConflict((oc) => oc.columns(['userId', 'environmentId']).doUpdateSet(update))
        .returningAll()
        .executeTakeFirstOrThrow();
      return toToolchainSelection(row);
    },

    async remove(userId, environmentId) {
      await db()
        .deleteFrom('environment_toolchains')
        .where('userId', '=', userId)
        .where('environmentId', '=', environmentId)
        .execute();
    },
  };
}

export const environmentToolchainRepository = createEnvironmentToolchainRepository();
