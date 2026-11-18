import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import { redactBackupDatabase } from '../../../../src/backup/privacy';
import { createBunSqliteDialect } from '../../../../src/db/bun-sqlite-dialect';
import { getDb } from '../../../../src/db/database';
import { allMigrations } from '../../../../src/db/migrations';
import type { Database } from '../../../../src/db/types';
import { createChatUseCase } from '../../../../src/modules/chats/application/create-chat';
import { ChatNotFoundError } from '../../../../src/modules/chats/domain/chat-ownership';
import { insertTestUser, makeTestIdentity } from '../../../support/factories';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

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

describe('createChatUseCase realtime invalidation', () => {
  afterEach(() => {
    restoreRealtimeBus();
  });

  it('signals the chat list once per created chat, and not on a replayed operation', async () => {
    // A new chat is list-visible in every other tab. Its feed row rides the
    // activity topic; the list's refresh must not depend on that row.
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const input = { userId: user.id, title: 'Announced chat', operationId: 'announce-once' };

    await createChatUseCase(input, getDb());
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);

    await createChatUseCase(input, getDb());
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);

    await createChatUseCase({ userId: user.id, title: 'Plain chat' }, getDb());
    expect(bus.chatListFramesFor(user.id)).toHaveLength(2);
  });
});
