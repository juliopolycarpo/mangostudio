import { afterEach, describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import type { ActivityEventInsert } from '../../../../src/db/types';
import {
  recordActivity,
  resetActivityRetentionSchedule,
} from '../../../../src/modules/activity/application/record-activity';
import {
  ACTIVITY_MAX_ROWS_PER_USER,
  ACTIVITY_RETENTION_INTERVAL_ROWS,
  ACTIVITY_RETENTION_MS,
  ACTIVITY_ROWS_KEPT_BY_PRUNE,
  createActivityRepository,
} from '../../../../src/modules/activity/infrastructure/activity-repository';

let userSeq = 0;
function userId(): string {
  userSeq += 1;
  return `activity-repo-user-${userSeq}`;
}

/**
 * A row with every scope column defaulted to `null`, so each test states only
 * the columns it is actually about — a new scope column lands here once rather
 * than in every literal below.
 */
function row(
  overrides: Partial<ActivityEventInsert> & { id: string; userId: string }
): ActivityEventInsert {
  return {
    kind: 'chat_created',
    createdAt: 1_000,
    chatId: null,
    workdir: null,
    environmentId: null,
    targetId: null,
    payloadJson: JSON.stringify({ title: overrides.id }),
    ...overrides,
  };
}

afterEach(async () => {
  // The suite shares one in-memory database for the whole process; every test
  // owns a fresh userId, but still cleans up so a later scan of the table
  // (were one ever added) cannot see rows from here.
  await getDb()
    .deleteFrom('activity_events')
    .where('userId', 'like', 'activity-repo-user-%')
    .execute();
});

describe('activity repository', () => {
  it('keeps keyset ordering total when two rows share a createdAt', async () => {
    const repository = createActivityRepository(getDb());
    const user = userId();
    const createdAt = 1_700_000_000_000;
    await repository.insertMany([
      row({ id: 'evt-a', userId: user, createdAt }),
      row({ id: 'evt-b', userId: user, createdAt }),
    ]);

    const first = await repository.list({ userId: user, limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const firstRow = first.rows[0];
    if (!firstRow) throw new Error('expected a row');

    const second = await repository.list({
      userId: user,
      limit: 1,
      cursor: { createdAt: firstRow.createdAt, id: firstRow.id },
    });
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    // Both rows come back exactly once across the two pages, in strict
    // descending `id` order for the tied millisecond.
    expect([firstRow.id, second.rows[0]?.id]).toEqual(['evt-b', 'evt-a']);
  });

  it('filters by since, exclusive of the boundary', async () => {
    const repository = createActivityRepository(getDb());
    const user = userId();
    await repository.insertMany([
      row({ id: 'evt-old', userId: user, createdAt: 1_000 }),
      row({ id: 'evt-new', userId: user, createdAt: 2_000 }),
    ]);

    const page = await repository.list({ userId: user, limit: 10, since: 1_000 });

    expect(page.rows.map((r) => r.id)).toEqual(['evt-new']);
  });

  it('filters by workdir', async () => {
    const repository = createActivityRepository(getDb());
    const user = userId();
    await repository.insertMany([
      row({
        id: 'evt-a',
        userId: user,
        kind: 'commit_created',
        createdAt: 1_000,
        workdir: '/repo/a',
        payloadJson: JSON.stringify({ subject: 'a', branch: null }),
      }),
      row({
        id: 'evt-b',
        userId: user,
        kind: 'commit_created',
        createdAt: 2_000,
        workdir: '/repo/b',
        payloadJson: JSON.stringify({ subject: 'b', branch: null }),
      }),
    ]);

    const page = await repository.list({ userId: user, limit: 10, workdir: '/repo/a' });

    expect(page.rows.map((r) => r.id)).toEqual(['evt-a']);
  });

  it('prune drops rows older than the 90-day retention boundary', async () => {
    const repository = createActivityRepository(getDb());
    const user = userId();
    const now = 100 * 24 * 60 * 60_000; // Far enough past epoch that "old" is not negative.
    const cutoff = now - ACTIVITY_RETENTION_MS;
    await repository.insertMany([
      row({ id: 'evt-too-old', userId: user, createdAt: cutoff - 1 }),
      row({ id: 'evt-at-cutoff', userId: user, createdAt: cutoff }),
      row({ id: 'evt-fresh', userId: user, createdAt: cutoff + 1 }),
    ]);

    await repository.prune(user, now);

    const page = await repository.list({ userId: user, limit: 10 });
    // Strictly-older-than-cutoff is pruned; the row exactly at the cutoff and
    // the fresher row survive (`deleteFrom(... '<', cutoff)`).
    expect(page.rows.map((r) => r.id).sort()).toEqual(['evt-at-cutoff', 'evt-fresh']);
  });
});

describe('activity retention cap', () => {
  // Real time: the recorder stamps its rows with `Date.now()`, after the seeded ones.
  const NOW = Date.now();

  /** Inserts `count` rows for `user`, ids `evt-00000`.., one per millisecond ending at `NOW`. */
  async function seedRows(
    user: string,
    count: number,
    createdAtOf = (index: number) => NOW - count + index
  ) {
    const rows = Array.from({ length: count }, (_, index) =>
      row({
        id: `evt-${String(index).padStart(5, '0')}`,
        userId: user,
        createdAt: createdAtOf(index),
      })
    );
    // Chunked: SQLite caps the bound parameters of one statement.
    for (let start = 0; start < rows.length; start += 500) {
      await createActivityRepository(getDb()).insertMany(rows.slice(start, start + 500));
    }
  }

  async function idsOf(user: string): Promise<string[]> {
    const rows = await getDb()
      .selectFrom('activity_events')
      .select('id')
      .where('userId', '=', user)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => r.id);
  }

  it('keeps exactly the newest rows a pass retains, splitting a createdAt tie by id', async () => {
    const user = userId();
    const total = ACTIVITY_ROWS_KEPT_BY_PRUNE + 10;
    // The ten oldest rows and the next ten share one createdAt, as a batch does,
    // so the boundary falls inside a tie.
    await seedRows(user, total, (index) => (index < 20 ? NOW - total : NOW - total + index));

    await createActivityRepository(getDb()).prune(user, NOW);

    const kept = await idsOf(user);
    expect(kept).toHaveLength(ACTIVITY_ROWS_KEPT_BY_PRUNE);
    expect(kept[0]).toBe('evt-00010');
  });

  it('never lets single-row writes take the feed past the cap', async () => {
    const user = userId();
    resetActivityRetentionSchedule();
    await seedRows(user, ACTIVITY_MAX_ROWS_PER_USER - 5);

    let largest = 0;
    for (let write = 0; write < 3 * ACTIVITY_RETENTION_INTERVAL_ROWS; write++) {
      await recordActivity(
        { userId: user, kind: 'chat_created', payload: { title: `write ${write}` } },
        { db: getDb(), publish: () => undefined }
      );
      largest = Math.max(largest, (await idsOf(user)).length);
    }

    if (largest > ACTIVITY_MAX_ROWS_PER_USER) {
      throw new Error(
        `expected feed rows: <= ${ACTIVITY_MAX_ROWS_PER_USER} | received: ${largest}`
      );
    }
  });
});
