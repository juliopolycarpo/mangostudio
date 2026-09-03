/**
 * Which Node and Bun every process spawned on one environment runs with.
 *
 * Keyed on `(userId, environmentId)` with no foreign key on `environmentId`:
 * the Local environment is virtual and never has a row in `environments`, so
 * `local` is a sentinel key here exactly as it is for install runs.
 */

import type { ToolchainSelection } from '@mangostudio/shared/environments';
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
  upsert(
    userId: string,
    environmentId: string,
    selection: ToolchainSelection,
    updatedAt: number
  ): Promise<void>;
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

    async upsert(userId, environmentId, selection, updatedAt) {
      const values: EnvironmentToolchainInsert = {
        userId,
        environmentId,
        nodeSelection: selection.node,
        bunSelection: selection.bun,
        updatedAt,
      };
      const update: EnvironmentToolchainUpdate = {
        nodeSelection: selection.node,
        bunSelection: selection.bun,
        updatedAt,
      };
      await db()
        .insertInto('environment_toolchains')
        .values(values)
        .onConflict((oc) => oc.columns(['userId', 'environmentId']).doUpdateSet(update))
        .execute();
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
