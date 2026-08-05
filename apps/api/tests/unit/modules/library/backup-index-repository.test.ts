/**
 * The listing index, against the real schema.
 *
 * The identity rule is the whole reason this table has a compound unique index:
 * backup ids are minted per store, so the same id legitimately exists on two
 * machines, and a row keyed on the id alone would let one machine's listing
 * overwrite another's.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import { createLibraryBackupIndex } from '../../../../src/modules/library/infrastructure/backup-index-repository';
import { insertTestUser } from '../../../support/factories';

const userIds: string[] = [];

afterEach(async () => {
  if (userIds.length === 0) return;
  const ids = userIds.splice(0);
  await getDb().deleteFrom('library_backups').where('userId', 'in', ids).execute();
  await getDb().deleteFrom('user').where('id', 'in', ids).execute();
});

describe('library backup index', () => {
  it('keeps one row per machine even when two machines mint the same backup id', async () => {
    const user = await insertTestUser();
    userIds.push(user.id);
    const index = createLibraryBackupIndex();
    const shared = '2026-08-05T10-00-00.000Z-abcdef';

    await index.record(user.id, [
      {
        environmentId: 'local',
        backupId: shared,
        createdAtMs: 10,
        sizeBytes: 100,
        pinned: false,
        operation: 'propagation',
      },
      {
        environmentId: 'wsl-ubuntu',
        backupId: shared,
        createdAtMs: 20,
        sizeBytes: 200,
        pinned: true,
        operation: 'removal',
      },
    ]);

    const rows = await index.list(user.id);
    expect(rows).toHaveLength(2);
    // Newest first, so the machine the user just acted on heads the page.
    expect(rows[0]).toEqual({
      environmentId: 'wsl-ubuntu',
      backupId: shared,
      createdAtMs: 20,
      sizeBytes: 200,
      pinned: true,
      operation: 'removal',
    });
  });

  it('refreshes a row in place when the machine is asked again', async () => {
    const user = await insertTestUser();
    userIds.push(user.id);
    const index = createLibraryBackupIndex();
    const row = {
      environmentId: 'local',
      backupId: 'set-1',
      createdAtMs: 1,
      sizeBytes: 10,
      pinned: false,
      operation: 'propagation' as const,
    };

    await index.record(user.id, [row]);
    // A set that acquired a last-copy pin, and grew, between two listings.
    await index.record(user.id, [{ ...row, sizeBytes: 4096, pinned: true }]);

    const rows = await index.list(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sizeBytes).toBe(4096);
    expect(rows[0].pinned).toBe(true);
  });

  it('scopes every read and write to one user', async () => {
    const user = await insertTestUser();
    const other = await insertTestUser();
    userIds.push(user.id, other.id);
    const index = createLibraryBackupIndex();
    const row = {
      environmentId: 'local',
      backupId: 'set-1',
      createdAtMs: 1,
      sizeBytes: 10,
      pinned: false,
      operation: 'removal' as const,
    };

    await index.record(user.id, [row]);
    await index.record(other.id, [row]);
    await index.forget(user.id, 'local', ['set-1']);

    expect(await index.list(user.id)).toEqual([]);
    expect(await index.list(other.id)).toHaveLength(1);
  });

  it('reads an unrecognized operation as unknown rather than dropping the row', async () => {
    const user = await insertTestUser();
    userIds.push(user.id);
    const index = createLibraryBackupIndex();
    await getDb()
      .insertInto('library_backups')
      .values({
        id: 'legacy-row',
        userId: user.id,
        environmentId: 'local',
        backupId: 'set-legacy',
        createdAtMs: 1,
        sizeBytes: 10,
        pinned: 0,
        operation: 'something-else',
      })
      .execute();

    // The bytes exist; a row that cannot say which flow wrote it is still worth
    // listing, and `unknown` is exactly the label the UI already renders.
    expect((await index.list(user.id))[0].operation).toBe('unknown');
  });
});
