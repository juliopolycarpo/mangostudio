import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type {
  Database,
  LibraryDivergenceAckInsert,
  LibraryDivergenceAckSelect,
} from '../../../db/types';
import { generateId } from '../../../utils/id';

export interface DivergenceAckRecord {
  readonly resourceKey: string;
  readonly divergenceKey: string;
  readonly contentHashes: string[];
  readonly acknowledgedAtMs: number;
}

export interface DivergenceAckRepository {
  list(userId: string, profileId: string): Promise<DivergenceAckRecord[]>;
  listFor(
    userId: string,
    profileId: string,
    resourceKeys: readonly string[]
  ): Promise<DivergenceAckRecord[]>;
  upsert(userId: string, profileId: string, record: DivergenceAckRecord): Promise<void>;
  remove(userId: string, profileId: string, resourceKeys: readonly string[]): Promise<void>;
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
    async list(userId, profileId) {
      const rows = await db
        .selectFrom('library_divergence_acks')
        .selectAll()
        .where('userId', '=', userId)
        .where('profileId', '=', profileId)
        .orderBy('resourceKey', 'asc')
        .execute();
      return toRecords(rows);
    },

    async listFor(userId, profileId, resourceKeys) {
      if (resourceKeys.length === 0) return [];
      const rows = await db
        .selectFrom('library_divergence_acks')
        .selectAll()
        .where('userId', '=', userId)
        .where('profileId', '=', profileId)
        .where('resourceKey', 'in', [...resourceKeys])
        .execute();
      return toRecords(rows);
    },

    async upsert(userId, profileId, record) {
      const values: LibraryDivergenceAckInsert = {
        id: generateId(),
        userId,
        profileId,
        resourceKey: record.resourceKey,
        divergenceKey: record.divergenceKey,
        contentHashesJson: JSON.stringify(record.contentHashes),
        acknowledgedAt: record.acknowledgedAtMs,
      };
      await db
        .insertInto('library_divergence_acks')
        .values(values)
        // Re-acknowledging a resource replaces the accepted hash set instead of
        // accumulating rows, so a resource never carries two live acks.
        .onConflict((conflict) =>
          conflict.columns(['userId', 'profileId', 'resourceKey']).doUpdateSet({
            divergenceKey: record.divergenceKey,
            contentHashesJson: JSON.stringify(record.contentHashes),
            acknowledgedAt: record.acknowledgedAtMs,
          })
        )
        .execute();
    },

    async remove(userId, profileId, resourceKeys) {
      if (resourceKeys.length === 0) return;
      await db
        .deleteFrom('library_divergence_acks')
        .where('userId', '=', userId)
        .where('profileId', '=', profileId)
        .where('resourceKey', 'in', [...resourceKeys])
        .execute();
    },
  };
}
