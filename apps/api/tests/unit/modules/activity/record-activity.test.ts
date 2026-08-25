import { describe, expect, it } from 'bun:test';
import type { ActivityEventInsert } from '../../../../src/db/types';
import {
  recordActivities,
  recordActivity,
} from '../../../../src/modules/activity/application/record-activity';
import type {
  ActivityListFilter,
  ActivityPage,
  ActivityRepository,
} from '../../../../src/modules/activity/infrastructure/activity-repository';

/** Named fake standing in for the real Kysely-backed repository. */
class FakeActivityRepository implements ActivityRepository {
  readonly inserted: ActivityEventInsert[] = [];
  readonly prunedFor: string[] = [];
  insertError: Error | undefined;
  pruneError: Error | undefined;

  /** Counts calls, not rows, so a test can prove a batch cost one statement. */
  insertCalls = 0;

  insertMany(rows: readonly ActivityEventInsert[]): Promise<void> {
    if (this.insertError) return Promise.reject(this.insertError);
    this.insertCalls += 1;
    this.inserted.push(...rows);
    return Promise.resolve();
  }

  list(_filter: ActivityListFilter): Promise<ActivityPage> {
    return Promise.resolve({ rows: [], hasMore: false });
  }

  prune(userId: string, _now: number): Promise<void> {
    if (this.pruneError) return Promise.reject(this.pruneError);
    this.prunedFor.push(userId);
    return Promise.resolve();
  }
}

/** Records every userId it was called with. */
class FakePublisher {
  readonly calledFor: string[] = [];

  publish = (userId: string): void => {
    this.calledFor.push(userId);
  };
}

describe('recordActivity', () => {
  it('inserts a row with the expected columns, defaulting unset scope to null', async () => {
    const repository = new FakeActivityRepository();
    const publisher = new FakePublisher();

    await recordActivity(
      {
        userId: 'user-1',
        kind: 'chat_created',
        chatId: 'chat-1',
        payload: { title: 'Hello' },
        createdAt: 1_700_000_000_000,
      },
      { repository, publish: publisher.publish }
    );

    expect(repository.inserted).toHaveLength(1);
    const row = repository.inserted[0];
    expect(row).toMatchObject({
      userId: 'user-1',
      kind: 'chat_created',
      createdAt: 1_700_000_000_000,
      chatId: 'chat-1',
      workdir: null,
      environmentId: null,
      targetId: null,
    });
    expect(row?.id.length).toBeGreaterThan(0);
    expect(JSON.parse(row?.payloadJson ?? '{}')).toEqual({ title: 'Hello' });
  });

  it('calls prune for the user after the insert', async () => {
    const repository = new FakeActivityRepository();

    await recordActivity(
      { userId: 'user-1', kind: 'chat_created', chatId: 'chat-1', payload: { title: 'Hi' } },
      { repository, publish: () => undefined }
    );

    expect(repository.prunedFor).toEqual(['user-1']);
  });

  it('calls publish with the userId after a successful write', async () => {
    const repository = new FakeActivityRepository();
    const publisher = new FakePublisher();

    await recordActivity(
      { userId: 'user-42', kind: 'chat_created', chatId: 'chat-1', payload: { title: 'Hi' } },
      { repository, publish: publisher.publish }
    );

    expect(publisher.calledFor).toEqual(['user-42']);
  });

  it('writes nothing for an empty userId', async () => {
    const repository = new FakeActivityRepository();
    const publisher = new FakePublisher();

    await recordActivity(
      { userId: '', kind: 'chat_created', chatId: 'chat-1', payload: { title: 'Hi' } },
      { repository, publish: publisher.publish }
    );

    expect(repository.inserted).toEqual([]);
    expect(repository.prunedFor).toEqual([]);
    expect(publisher.calledFor).toEqual([]);
  });

  it('does not reject and does not publish when the repository insert rejects', async () => {
    const repository = new FakeActivityRepository();
    repository.insertError = new Error('disk is on fire');
    const publisher = new FakePublisher();

    // The whole point of `recordActivity`: activity is best-effort telemetry,
    // never a reason to fail the operation that produced it.
    await expect(
      recordActivity(
        { userId: 'user-1', kind: 'chat_created', chatId: 'chat-1', payload: { title: 'Hi' } },
        { repository, publish: publisher.publish }
      )
    ).resolves.toBeUndefined();

    expect(publisher.calledFor).toEqual([]);
    expect(repository.prunedFor).toEqual([]);
  });
  it('still announces a row whose retention pass failed', async () => {
    const repository = new FakeActivityRepository();
    const publisher = new FakePublisher();
    repository.pruneError = new Error('disk full');

    await recordActivity(
      { userId: 'user-1', kind: 'chat_created', payload: { title: 'Hello' } },
      { repository, publish: publisher.publish }
    );

    // The row is durable either way; retention is housekeeping, and a reader
    // who never learns the row exists is a worse outcome than a table that
    // grows one page past its cap.
    expect(repository.inserted).toHaveLength(1);
    expect(publisher.calledFor).toEqual(['user-1']);
  });
});

describe('recordActivities', () => {
  it('writes a batch as one statement, one announcement, and one retention pass', async () => {
    const repository = new FakeActivityRepository();
    const publisher = new FakePublisher();

    await recordActivities(
      'user-1',
      [
        { kind: 'chat_created', payload: { title: 'One' } },
        { kind: 'chat_created', payload: { title: 'Two' } },
        { kind: 'chat_created', payload: { title: 'Three' } },
      ],
      { repository, publish: publisher.publish }
    );

    // Three rows for the reader, but one round trip and one socket frame: an
    // apply that touched seven resources must not cost seven of each.
    expect(repository.inserted).toHaveLength(3);
    expect(repository.insertCalls).toBe(1);
    expect(publisher.calledFor).toEqual(['user-1']);
    expect(repository.prunedFor).toEqual(['user-1']);
  });

  it('gives every row in a batch its own id', async () => {
    const repository = new FakeActivityRepository();

    await recordActivities(
      'user-1',
      [
        { kind: 'chat_created', payload: { title: 'One' } },
        { kind: 'chat_created', payload: { title: 'Two' } },
      ],
      { repository, publish: () => undefined }
    );

    const ids = new Set(repository.inserted.map((row) => row.id));
    expect(ids.size).toBe(2);
  });

  it('writes nothing for an empty batch', async () => {
    const repository = new FakeActivityRepository();
    const publisher = new FakePublisher();

    // An apply that wrote no resources is not an event; it must not cost a
    // statement or wake every open tab.
    await recordActivities('user-1', [], { repository, publish: publisher.publish });

    expect(repository.insertCalls).toBe(0);
    expect(publisher.calledFor).toEqual([]);
    expect(repository.prunedFor).toEqual([]);
  });
});
