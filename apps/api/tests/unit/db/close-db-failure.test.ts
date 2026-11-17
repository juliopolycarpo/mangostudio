/**
 * A driver whose close throws must not leave `getDb` returning the destroyed instance:
 * the next open has to build a fresh, usable connection.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { Kysely, sql } from 'kysely';

import { closeDb, getDb } from '../../../src/db/database';

const DRIVER_CLOSE_FAILURE = 'driver close failed: simulated';

/** Stands in for `Kysely.destroy`: rejects without releasing anything, like a failing driver. */
function destroyThatFails(): Promise<void> {
  return Promise.reject(new Error(DRIVER_CLOSE_FAILURE));
}

afterEach(async () => {
  await closeDb().catch(() => undefined);
});

describe('closeDb after a driver close failure', () => {
  it('surfaces the failure, then opens a usable connection instead of the destroyed one', async () => {
    const first = getDb();
    const destroySpy = spyOn(Kysely.prototype, 'destroy').mockImplementationOnce(destroyThatFails);

    try {
      await expect(closeDb()).rejects.toThrow(DRIVER_CLOSE_FAILURE);
    } finally {
      destroySpy.mockRestore();
    }

    const second = getDb();
    if (second === first) {
      throw new Error(
        'expected a usable connection after a failed close | received: destroyed instance'
      );
    }
    const row = await sql<{ one: number }>`select 1 as one`.execute(second);
    expect(row.rows).toEqual([{ one: 1 }]);
  });

  it('treats a second closeDb as a no-op', async () => {
    getDb();
    await closeDb();
    await expect(closeDb()).resolves.toBeUndefined();
  });
});
