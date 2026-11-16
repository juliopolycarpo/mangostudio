import { Database as SQLiteDatabase } from 'bun:sqlite';
import { expect, it } from 'bun:test';

import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import { redactBackupDatabase } from '../../../src/backup/privacy';
import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';

it('retains saved onboarding receipts without their private result snapshots', async () => {
  const sqlite = new SQLiteDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
  try {
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    }).migrateToLatest();
    if (error) throw new Error('Backup privacy fixture migration failed.', { cause: error });
    const userId = 'backup-user';
    const now = new Date().toISOString();
    await db
      .insertInto('user')
      .values({
        id: userId,
        name: 'Fixture',
        email: 'fixture@example.com',
        emailVerified: 0,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const settingsJson = JSON.stringify({
      onboarding: {
        chatId: 'first-chat',
        requiresTurnReceipt: true,
        createChatOperation: { operationId: 'creation', title: 'First chat' },
        turnOperation: { operationId: 'turn', prompt: 'Hello' },
      },
    });
    await db
      .insertInto('user_app_settings')
      .values({ id: 'settings', userId, settingsJson, createdAt: 1, updatedAt: 1 })
      .execute();
    await db
      .insertInto('product_operations')
      .values([
        {
          userId,
          operationId: 'creation',
          kind: 'create-chat',
          state: 'completed',
          fingerprint: 'creation-fingerprint',
          owner: 'old-hub',
          chatId: 'first-chat',
          messageId: null,
          result: '{"private":"snapshot-fixture-secret"}',
          createdAt: 1,
          expiresAt: 9_999_999_999_999,
        },
        {
          userId,
          operationId: 'turn',
          kind: 'submit-turn',
          state: 'running',
          fingerprint: 'turn-fingerprint',
          owner: 'old-hub',
          chatId: 'first-chat',
          messageId: 'answer',
          result: null,
          createdAt: 1,
          expiresAt: 9_999_999_999_999,
        },
      ])
      .execute();

    redactBackupDatabase(sqlite, true);

    const receipts = await db
      .selectFrom('product_operations')
      .select(['operationId', 'state', 'chatId', 'messageId', 'fingerprint', 'result'])
      .orderBy('operationId')
      .execute();
    expect(receipts).toEqual([
      {
        operationId: 'creation',
        state: 'completed',
        chatId: 'first-chat',
        messageId: null,
        fingerprint: 'creation-fingerprint',
        result: null,
      },
      {
        operationId: 'turn',
        state: 'unresolved',
        chatId: 'first-chat',
        messageId: 'answer',
        fingerprint: 'turn-fingerprint',
        result: null,
      },
    ]);
    expect(
      (await db.selectFrom('user_app_settings').select('settingsJson').executeTakeFirst())
        ?.settingsJson
    ).toBe(settingsJson);
    expect(Buffer.from(sqlite.serialize()).includes('snapshot-fixture-secret')).toBe(false);
  } finally {
    await db.destroy();
  }
});

it('keeps the text of a turn running during capture but not the provider state its checkpoints carry', async () => {
  const sqlite = new SQLiteDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: createBunSqliteDialect(sqlite) });
  try {
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    }).migrateToLatest();
    if (error) throw new Error('Backup privacy fixture migration failed.', { cause: error });
    const now = new Date().toISOString();
    await db
      .insertInto('user')
      .values({
        id: 'u',
        name: 'Fixture',
        email: 'fixture@example.com',
        emailVerified: 0,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    await db
      .insertInto('chats')
      .values({ id: 'c', userId: 'u', title: 't', createdAt: 1, updatedAt: 1 } as never)
      .execute();
    await db
      .insertInto('messages')
      .values({
        id: 'm',
        chatId: 'c',
        role: 'ai',
        text: '',
        timestamp: 1,
        isGenerating: 1,
        parts: '[]',
        providerState: 'row-provider-state-secret',
      } as never)
      .execute();
    await db
      .insertInto('message_checkpoint_deltas')
      .values({
        messageId: 'm',
        seq: 1,
        delta: JSON.stringify({
          text: 'partial answer',
          providerState: 'delta-provider-state-secret',
        }),
      })
      .execute();

    redactBackupDatabase(sqlite, true);

    const delta = await db
      .selectFrom('message_checkpoint_deltas')
      .select('delta')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(delta.delta)).toEqual({ text: 'partial answer' });
    const bytes = Buffer.from(sqlite.serialize());
    expect(bytes.includes('delta-provider-state-secret')).toBe(false);
    expect(bytes.includes('row-provider-state-secret')).toBe(false);
  } finally {
    await db.destroy();
  }
});
