import { Database as SQLiteDatabase } from 'bun:sqlite';
import { expect, it } from 'bun:test';

import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import { redactBackupDatabase } from '../../../../src/backup/privacy';
import { createBunSqliteDialect } from '../../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../../src/db/migrations';
import type { Database } from '../../../../src/db/types';
import { createChatUseCase } from '../../../../src/modules/chats/application/create-chat';
import { ChatNotFoundError } from '../../../../src/modules/chats/domain/chat-ownership';
import { makeTestIdentity } from '../../../support/factories';

it('replays an owned chat after backup removes its completed result snapshot', async () => {
  const sqlite = new SQLiteDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
  try {
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    }).migrateToLatest();
    if (error) throw new Error('Create-chat replay fixture migration failed.', { cause: error });
    const owner = makeTestIdentity('replay-owner', 'Owner');
    const other = makeTestIdentity('replay-other', 'Other account');
    const now = new Date().toISOString();
    await db
      .insertInto('user')
      .values(
        [owner, other].map((user) => ({
          ...user,
          emailVerified: 0,
          image: null,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .execute();
    const input = { userId: owner.id, title: 'Original chat', operationId: 'create-once' };

    const original = await createChatUseCase(input, db);
    await db
      .updateTable('chats')
      .set({ title: 'Renamed chat' })
      .where('id', '=', original.id)
      .execute();
    expect(await createChatUseCase(input, db)).toEqual(original);

    redactBackupDatabase(sqlite, true);
    const receipt = await db
      .selectFrom('product_operations')
      .select(['state', 'chatId', 'result'])
      .where('userId', '=', owner.id)
      .where('operationId', '=', input.operationId)
      .executeTakeFirstOrThrow();
    expect(receipt).toEqual({ state: 'completed', chatId: original.id, result: null });
    expect(await createChatUseCase(input, db)).toEqual({ ...original, title: 'Renamed chat' });
    expect(await db.selectFrom('chats').select('id').execute()).toEqual([{ id: original.id }]);

    await db
      .updateTable('chats')
      .set({ userId: other.id, runnerAgentId: null })
      .where('id', '=', original.id)
      .execute();
    await expect(createChatUseCase(input, db)).rejects.toBeInstanceOf(ChatNotFoundError);
    await db.deleteFrom('chats').where('id', '=', original.id).execute();
    await expect(createChatUseCase(input, db)).rejects.toBeInstanceOf(ChatNotFoundError);
    expect(await db.selectFrom('chats').select('id').execute()).toEqual([]);
  } finally {
    await db.destroy();
  }
});
