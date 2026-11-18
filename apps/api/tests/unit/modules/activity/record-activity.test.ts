import { beforeEach, describe, expect, it } from 'bun:test';

import type { ActivityEventInsert } from '../../../../src/db/types';
import {
  recordActivities,
  recordActivity,
  resetActivityRetentionSchedule,
} from '../../../../src/modules/activity/application/record-activity';
import {
  ACTIVITY_RETENTION_INTERVAL_ROWS,
  type ActivityListFilter,
  type ActivityPage,
  type ActivityRepository,
} from '../../../../src/modules/activity/infrastructure/activity-repository';
import { RecordingDiagnosticLogger } from '../../../support/mocks/recording-diagnostic-logger';
import { waitUntil } from '../../../support/wait-until';

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

  /** While set, each prune stays pending until {@link releasePrunes}. */
  holdPrunes = false;
  private readonly heldPrunes: (() => void)[] = [];

  prune(userId: string, _now: number): Promise<void> {
    if (this.pruneError) return Promise.reject(this.pruneError);
    this.prunedFor.push(userId);
    if (!this.holdPrunes) return Promise.resolve();
    return new Promise((resolve) => this.heldPrunes.push(resolve));
  }

  releasePrunes(): void {
    for (const release of this.heldPrunes.splice(0)) release();
  }
}

/** Records every userId it was called with. */
class FakePublisher {
  readonly calledFor: string[] = [];

  publish = (userId: string): void => {
    this.calledFor.push(userId);
  };
}

// The retention schedule is per account and per process; every test starts with all accounts due.
beforeEach(resetActivityRetentionSchedule);

describe('retention schedule', () => {
  const entry = { kind: 'chat_created', payload: { title: 'Hi' } } as const;

  async function write(repository: FakeActivityRepository, userId: string, count = 1) {
    for (let index = 0; index < count; index++) {
      await recordActivity({ userId, ...entry }, { repository, publish: () => undefined });
    }
  }

  it('prunes on the first write of an account, then once per interval of rows', async () => {
    const repository = new FakeActivityRepository();

    await write(repository, 'user-1', ACTIVITY_RETENTION_INTERVAL_ROWS);
    expect(repository.prunedFor).toEqual(['user-1']);

    await write(repository, 'user-1');
    expect(repository.prunedFor).toEqual(['user-1', 'user-1']);
    expect(repository.inserted).toHaveLength(ACTIVITY_RETENTION_INTERVAL_ROWS + 1);
  });

  it('counts the rows of a batch, not the calls', async () => {
    const repository = new FakeActivityRepository();
    await write(repository, 'user-1');
    const batch = Array.from({ length: ACTIVITY_RETENTION_INTERVAL_ROWS }, () => entry);

    await recordActivities('user-1', batch, { repository, publish: () => undefined });

    expect(repository.prunedFor).toEqual(['user-1', 'user-1']);
  });

  it('keeps one schedule per account', async () => {
    const repository = new FakeActivityRepository();

    await write(repository, 'user-1');
    await write(repository, 'user-2');
    await write(repository, 'user-1');

    expect(repository.prunedFor).toEqual(['user-1', 'user-2']);
  });

  it('counts a row written while a pass is still running toward the next pass', async () => {
    const repository = new FakeActivityRepository();
    await write(repository, 'user-1', ACTIVITY_RETENTION_INTERVAL_ROWS);
    repository.holdPrunes = true;

    // The 50th row since the last pass makes this write due; its pass stays pending.
    const due = recordActivity(
      { userId: 'user-1', ...entry },
      { repository, publish: () => undefined }
    );
    const during = recordActivity(
      { userId: 'user-1', ...entry },
      { repository, publish: () => undefined }
    );
    await waitUntil(
      () => repository.inserted.length === ACTIVITY_RETENTION_INTERVAL_ROWS + 2,
      'both writes inserted'
    );
    repository.releasePrunes();
    await Promise.all([due, during]);
    repository.holdPrunes = false;
    const passesBefore = repository.prunedFor.length;

    // The row written during the pass already counts, so 49 more rows make the next one due.
    await write(repository, 'user-1', ACTIVITY_RETENTION_INTERVAL_ROWS - 1);

    const passes = repository.prunedFor.length - passesBefore;
    if (passes !== 1) {
      throw new Error(
        `expected passes after ${ACTIVITY_RETENTION_INTERVAL_ROWS - 1} more rows: 1 | received: ${passes}`
      );
    }
  });

  it('retries on the next write after a failed prune instead of waiting a full interval', async () => {
    const repository = new FakeActivityRepository();
    repository.pruneError = new Error('disk full');
    await write(repository, 'user-1');
    repository.pruneError = undefined;

    await write(repository, 'user-1');

    expect(repository.prunedFor).toEqual(['user-1']);
  });
});

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

  it('publishes one frame and logs the failure when the repository insert rejects', async () => {
    const repository = new FakeActivityRepository();
    repository.insertError = new Error('disk is on fire');
    const publisher = new FakePublisher();
    const logger = new RecordingDiagnosticLogger();

    // The whole point of `recordActivity`: activity is best-effort telemetry,
    // never a reason to fail the operation that produced it.
    await expect(
      recordActivity(
        {
          userId: 'user-1',
          kind: 'chat_created',
          chatId: 'chat-1',
          payload: { title: 'secret title' },
        },
        { repository, publish: publisher.publish, logger }
      )
    ).resolves.toBeUndefined();

    // The event happened even though its row did not land; open feeds refetch.
    expect(publisher.calledFor).toEqual(['user-1']);
    expect(repository.prunedFor).toEqual([]);
    expect(logger.events('error')).toEqual(['insert_failed']);
    const metadata = logger.entries[0]?.metadata;
    expect(metadata).toMatchObject({ userId: 'user-1', rowCount: 1, kinds: ['chat_created'] });
    expect((metadata?.error as Error).message).toBe('disk is on fire');
    expect(JSON.stringify(metadata)).not.toContain('secret title');
  });

  it('publishes only after the insert resolved', async () => {
    const order: string[] = [];
    const repository = new FakeActivityRepository();
    const insertMany = repository.insertMany.bind(repository);
    repository.insertMany = async (rows) => {
      await insertMany(rows);
      order.push('insert');
    };
    const logger = new RecordingDiagnosticLogger();

    await recordActivity(
      { userId: 'user-1', kind: 'chat_created', payload: { title: 'Hi' } },
      { repository, publish: () => order.push('publish'), logger }
    );

    expect(order).toEqual(['insert', 'publish']);
    expect(logger.entries).toEqual([]);
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
