import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type { ActivityEventInsert, ActivityEventSelect, Database } from '../../../db/types';

/** Rows older than this are dropped on the next write for the same user. */
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Hard cap per user, so a heavy week cannot outgrow the retention window. */
export const ACTIVITY_MAX_ROWS_PER_USER = 5_000;

export interface ActivityListFilter {
  readonly userId: string;
  /** Exclusive lower bound on `createdAt`. */
  readonly since?: number;
  readonly workdir?: string;
  readonly limit: number;
  readonly cursor?: ActivityCursor;
}

/**
 * Keyset position in the feed.
 *
 * `id` is part of it because two events can land in the same millisecond — a
 * commit and the turn that made it — and a cursor on `createdAt` alone would
 * either repeat or skip whichever of them the page boundary fell between.
 */
export interface ActivityCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface ActivityPage {
  readonly rows: readonly ActivityEventSelect[];
  readonly hasMore: boolean;
}

export interface ActivityRepository {
  insert(row: ActivityEventInsert): Promise<void>;
  list(filter: ActivityListFilter): Promise<ActivityPage>;
  prune(userId: string, now: number): Promise<void>;
}

/**
 * `injected` is resolved per call rather than defaulted at construction, for the
 * same reason as {@link createInstallRunRepository}: the recorder is built at
 * module scope, so an eager `= getDb()` default would open SQLite as a side
 * effect of importing any emission seam.
 */
export function createActivityRepository(injected?: Kysely<Database>): ActivityRepository {
  const db = (): Kysely<Database> => injected ?? getDb();

  return {
    async insert(row) {
      await db().insertInto('activity_events').values(row).execute();
    },

    async list(filter) {
      let query = db()
        .selectFrom('activity_events')
        .selectAll()
        .where('userId', '=', filter.userId);

      if (filter.since !== undefined) {
        query = query.where('createdAt', '>', filter.since);
      }
      if (filter.workdir !== undefined) {
        query = query.where('workdir', '=', filter.workdir);
      }
      const cursor = filter.cursor;
      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb('createdAt', '<', cursor.createdAt),
            eb.and([eb('createdAt', '=', cursor.createdAt), eb('id', '<', cursor.id)]),
          ])
        );
      }

      // One extra row answers "is there a next page" without a second COUNT.
      const rows = await query
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(filter.limit + 1)
        .execute();

      return { rows: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit };
    },

    async prune(userId, now) {
      const ageCutoff = now - ACTIVITY_RETENTION_MS;
      // The `createdAt` of the oldest row the cap keeps. Reading it costs one
      // walk of the covering index rather than a COUNT plus a second pass, and
      // collapses both retention rules into a single range delete below.
      const overflow = await db()
        .selectFrom('activity_events')
        .select('createdAt')
        .where('userId', '=', userId)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .offset(ACTIVITY_MAX_ROWS_PER_USER - 1)
        .executeTakeFirst();

      const cutoff = Math.max(ageCutoff, overflow?.createdAt ?? 0);
      if (cutoff <= 0) return;

      await db()
        .deleteFrom('activity_events')
        .where('userId', '=', userId)
        .where('createdAt', '<', cutoff)
        .execute();
    },
  };
}
