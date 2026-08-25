import { afterEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  ACTIVITY_RETENTION_MS,
  createActivityRepository,
} from '../../../../src/modules/activity/infrastructure/activity-repository';

let userSeq = 0;
function userId(): string {
  userSeq += 1;
  return `activity-repo-user-${userSeq}`;
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
    await repository.insert({
      id: 'evt-a',
      userId: user,
      kind: 'chat_created',
      createdAt,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'A' }),
    });
    await repository.insert({
      id: 'evt-b',
      userId: user,
      kind: 'chat_created',
      createdAt,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'B' }),
    });

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
    await repository.insert({
      id: 'evt-old',
      userId: user,
      kind: 'chat_created',
      createdAt: 1_000,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'Old' }),
    });
    await repository.insert({
      id: 'evt-new',
      userId: user,
      kind: 'chat_created',
      createdAt: 2_000,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'New' }),
    });

    const page = await repository.list({ userId: user, limit: 10, since: 1_000 });

    expect(page.rows.map((r) => r.id)).toEqual(['evt-new']);
  });

  it('filters by workdir', async () => {
    const repository = createActivityRepository(getDb());
    const user = userId();
    await repository.insert({
      id: 'evt-a',
      userId: user,
      kind: 'commit_created',
      createdAt: 1_000,
      chatId: null,
      workdir: '/repo/a',
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ subject: 'a', branch: null }),
    });
    await repository.insert({
      id: 'evt-b',
      userId: user,
      kind: 'commit_created',
      createdAt: 2_000,
      chatId: null,
      workdir: '/repo/b',
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ subject: 'b', branch: null }),
    });

    const page = await repository.list({ userId: user, limit: 10, workdir: '/repo/a' });

    expect(page.rows.map((r) => r.id)).toEqual(['evt-a']);
  });

  it('prune drops rows older than the 90-day retention boundary', async () => {
    const repository = createActivityRepository(getDb());
    const user = userId();
    const now = 100 * 24 * 60 * 60_000; // Far enough past epoch that "old" is not negative.
    const cutoff = now - ACTIVITY_RETENTION_MS;
    await repository.insert({
      id: 'evt-too-old',
      userId: user,
      kind: 'chat_created',
      createdAt: cutoff - 1,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'Too old' }),
    });
    await repository.insert({
      id: 'evt-at-cutoff',
      userId: user,
      kind: 'chat_created',
      createdAt: cutoff,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'At cutoff' }),
    });
    await repository.insert({
      id: 'evt-fresh',
      userId: user,
      kind: 'chat_created',
      createdAt: cutoff + 1,
      chatId: null,
      workdir: null,
      environmentId: null,
      targetId: null,
      payloadJson: JSON.stringify({ title: 'Fresh' }),
    });

    await repository.prune(user, now);

    const page = await repository.list({ userId: user, limit: 10 });
    // Strictly-older-than-cutoff is pruned; the row exactly at the cutoff and
    // the fresher row survive (`deleteFrom(... '<', cutoff)`).
    expect(page.rows.map((r) => r.id).sort()).toEqual(['evt-at-cutoff', 'evt-fresh']);
  });
});
