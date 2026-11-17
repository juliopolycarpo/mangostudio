/**
 * A driver whose close throws must not leave `getDb` returning the destroyed instance:
 * the next open has to build a fresh, usable connection.
 */
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { Kysely, sql } from 'kysely';

import { closeDb, getDb } from '../../../src/db/database';

const DRIVER_CLOSE_FAILURE = 'driver close failed: simulated';
const HANDLE_CLOSE_FAILURE = 'handle close failed: simulated';

/** Stands in for `Kysely.destroy`: rejects without releasing anything, like a failing driver. */
function destroyThatFails(): Promise<void> {
  return Promise.reject(new Error(DRIVER_CLOSE_FAILURE));
}

/** Stands in for `Database.close`: throws without releasing the file, like a failing handle. */
function handleCloseThatFails(): never {
  throw new Error(HANDLE_CLOSE_FAILURE);
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

  it('reports both errors when the driver close and the handle close both throw', async () => {
    getDb();
    const destroySpy = spyOn(Kysely.prototype, 'destroy').mockImplementationOnce(destroyThatFails);
    const closeSpy = spyOn(SQLiteDatabase.prototype, 'close').mockImplementationOnce(
      handleCloseThatFails
    );

    let failure: unknown;
    try {
      await closeDb();
    } catch (error) {
      failure = error;
    } finally {
      destroySpy.mockRestore();
      closeSpy.mockRestore();
    }

    const messages =
      failure instanceof AggregateError
        ? failure.errors.map((error: unknown) => (error instanceof Error ? error.message : error))
        : failure;
    expect(messages).toEqual([DRIVER_CLOSE_FAILURE, HANDLE_CLOSE_FAILURE]);
  });

  it('makes a concurrent closeDb wait for the close in flight and close the handle once', async () => {
    getDb();
    const destroyHeld = Promise.withResolvers<void>();
    const destroySpy = spyOn(Kysely.prototype, 'destroy').mockImplementationOnce(
      () => destroyHeld.promise
    );
    const closeSpy = spyOn(SQLiteDatabase.prototype, 'close');
    try {
      const first = closeDb();
      let secondSettled = false;
      const second = closeDb().then(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (secondSettled) {
        throw new Error(
          'expected the second closeDb to wait for the held destroy | received: resolved early'
        );
      }

      destroyHeld.resolve();
      await Promise.all([first, second]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      destroyHeld.resolve();
      destroySpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});
