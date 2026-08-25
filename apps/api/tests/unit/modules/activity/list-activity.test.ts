import { describe, expect, it } from 'bun:test';
import { ACTIVITY_PAGE_LIMIT_DEFAULT, ACTIVITY_PAGE_LIMIT_MAX } from '@mangostudio/shared/activity';
import type { ActivityEventSelect } from '../../../../src/db/types';
import { listActivity } from '../../../../src/modules/activity/application/list-activity';
import { encodeActivityCursor } from '../../../../src/modules/activity/domain/activity-cursor';
import type {
  ActivityListFilter,
  ActivityPage,
  ActivityRepository,
} from '../../../../src/modules/activity/infrastructure/activity-repository';

/** A repository whose `list` always answers with the rows it was constructed with. */
class FixedActivityRepository implements ActivityRepository {
  lastFilter: ActivityListFilter | undefined;

  constructor(private readonly page: ActivityPage) {}

  insertMany(): Promise<void> {
    return Promise.resolve();
  }

  list(filter: ActivityListFilter): Promise<ActivityPage> {
    this.lastFilter = filter;
    return Promise.resolve(this.page);
  }

  prune(): Promise<void> {
    return Promise.resolve();
  }
}

function row(overrides: {
  id?: string;
  kind?: string;
  createdAt?: number;
  payloadJson?: string;
}): ActivityEventSelect {
  return {
    id: overrides.id ?? 'evt-1',
    userId: 'user-1',
    kind: overrides.kind ?? 'chat_created',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    chatId: 'chat-1',
    workdir: null,
    environmentId: null,
    targetId: null,
    payloadJson: overrides.payloadJson ?? JSON.stringify({ title: 'Hello' }),
  };
}

describe('listActivity', () => {
  it('drops a row whose kind is not a known kind and still returns the response', async () => {
    const repository = new FixedActivityRepository({
      rows: [row({ id: 'evt-1', kind: 'not_a_kind' })],
      hasMore: false,
    });

    const result = await listActivity('user-1', {}, { repository });

    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('drops a row with well-formed kind but garbage payloadJson', async () => {
    const repository = new FixedActivityRepository({
      rows: [row({ id: 'evt-1', payloadJson: '{not json' })],
      hasMore: false,
    });

    const result = await listActivity('user-1', {}, { repository });

    expect(result.events).toEqual([]);
  });

  it('drops a row whose payload does not match its kind schema', async () => {
    const repository = new FixedActivityRepository({
      rows: [row({ id: 'evt-1', kind: 'chat_created', payloadJson: JSON.stringify({}) })],
      hasMore: false,
    });

    const result = await listActivity('user-1', {}, { repository });

    expect(result.events).toEqual([]);
  });

  it('derives nextCursor from the last row scanned, not the last row kept', async () => {
    const keptRow = row({ id: 'evt-kept', createdAt: 2_000, kind: 'chat_created' });
    const unreadableRow = row({ id: 'evt-unreadable', createdAt: 1_000, kind: 'not_a_kind' });
    const repository = new FixedActivityRepository({
      // The unreadable row is last in scan order (oldest), and would be
      // dropped from `events` — pagination must still advance past it.
      rows: [keptRow, unreadableRow],
      hasMore: true,
    });

    const result = await listActivity('user-1', {}, { repository });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('evt-kept');
    expect(result.nextCursor).toBe(
      encodeActivityCursor({ createdAt: 1_000, id: 'evt-unreadable' })
    );
  });

  it('defaults limit to ACTIVITY_PAGE_LIMIT_DEFAULT', async () => {
    const repository = new FixedActivityRepository({ rows: [], hasMore: false });

    await listActivity('user-1', {}, { repository });

    expect(repository.lastFilter?.limit).toBe(ACTIVITY_PAGE_LIMIT_DEFAULT);
  });

  it('clamps an out-of-range limit to ACTIVITY_PAGE_LIMIT_MAX', async () => {
    const repository = new FixedActivityRepository({ rows: [], hasMore: false });

    await listActivity('user-1', { limit: 10_000 }, { repository });

    expect(repository.lastFilter?.limit).toBe(ACTIVITY_PAGE_LIMIT_MAX);
  });

  it('clamps a below-minimum limit up to 1', async () => {
    const repository = new FixedActivityRepository({ rows: [], hasMore: false });

    await listActivity('user-1', { limit: 0 }, { repository });

    expect(repository.lastFilter?.limit).toBe(1);
  });
});
