import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type { Database, LibraryDivergenceAckSelect } from '../../../db/types';
import { generateId } from '../../../utils/id';

export interface DivergenceAckRecord {
  readonly resourceKey: string;
  readonly divergenceKey: string;
  readonly contentHashes: string[];
  readonly acknowledgedAtMs: number;
}

export interface DivergenceAckRepository {
  list(userId: string): Promise<DivergenceAckRecord[]>;
  listFor(userId: string, resourceKeys: readonly string[]): Promise<DivergenceAckRecord[]>;
  upsert(userId: string, record: DivergenceAckRecord): Promise<void>;
  remove(userId: string, resourceKeys: readonly string[]): Promise<void>;
}

/**
 * A stored row whose hashes cannot be parsed is treated as absent rather than
 * fatal: the worst outcome of dropping one is that the UI flags a divergence
 * the user had already accepted, which is recoverable by acknowledging again.
 */
function toRecord(row: LibraryDivergenceAckSelect): DivergenceAckRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.contentHashesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.some((hash) => typeof hash !== 'string')) return null;
  return {
    resourceKey: row.resourceKey,
    divergenceKey: row.divergenceKey,
    contentHashes: parsed,
    acknowledgedAtMs: row.acknowledgedAt,
  };
}

function toRecords(rows: readonly LibraryDivergenceAckSelect[]): DivergenceAckRecord[] {
  return rows.flatMap((row) => {
    const record = toRecord(row);
    return record ? [record] : [];
  });
}

export function createDivergenceAckRepository(
  db: Kysely<Database> = getDb()
): DivergenceAckRepository {
  return {
    async list(userId) {
      const rows = await db
        .selectFrom('library_divergence_acks')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('resourceKey', 'asc')
        .execute();
      return toRecords(rows);
    },

    async listFor(userId, resourceKeys) {
      if (resourceKeys.length === 0) return [];
      const rows = await db
        .selectFrom('library_divergence_acks')
        .selectAll()
        .where('userId', '=', userId)
        .where('resourceKey', 'in', [...resourceKeys])
        .execute();
      return toRecords(rows);
    },

    async upsert(userId, record) {
      await db
        .insertInto('library_divergence_acks')
        .values({
          id: generateId(),
          userId,
          resourceKey: record.resourceKey,
          divergenceKey: record.divergenceKey,
          contentHashesJson: JSON.stringify(record.contentHashes),
          acknowledgedAt: record.acknowledgedAtMs,
        })
        // Re-acknowledging a resource replaces the accepted hash set instead of
        // accumulating rows, so a resource never carries two live acks.
        .onConflict((conflict) =>
          conflict.columns(['userId', 'resourceKey']).doUpdateSet({
            divergenceKey: record.divergenceKey,
            contentHashesJson: JSON.stringify(record.contentHashes),
            acknowledgedAt: record.acknowledgedAtMs,
          })
        )
        .execute();
    },

    async remove(userId, resourceKeys) {
      if (resourceKeys.length === 0) return;
      await db
        .deleteFrom('library_divergence_acks')
        .where('userId', '=', userId)
        .where('resourceKey', 'in', [...resourceKeys])
        .execute();
    },
  };
}
