/**
 * Migration 066 adds `chats.searchText` and fills it for every chat that
 * exists. The fill is a frozen copy of `chatSearchKey`, so these cases replay
 * it on a real SQLite engine and hold the copy to the live function: a chat
 * backfilled by the migration must hold what `createChat` would have stored.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import { chatSearchKey } from '../../../src/modules/chats/domain/chat-search-key';

const BEFORE = '065_message_checkpoint_deltas';
const TARGET = '066_chat_search_text';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pre-066 schema is not the shape `Database` describes.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;

async function migrateTo(name: string): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });
  const { error } = await migrator.migrateTo(name);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- The migration error is rethrown unchanged so the test observes the original failure.
  if (error) throw error;
}

interface SeedChat {
  id: string;
  title: string;
  workdir?: string | null;
  runnerKind?: string;
  runnerTargetId?: string | null;
}

async function seedChat(chat: SeedChat): Promise<void> {
  await sql`
    INSERT INTO chats (id, title, createdAt, updatedAt, userId, workdir, runnerKind, runnerTargetId)
    VALUES (${chat.id}, ${chat.title}, 0, 0, 'user-1', ${chat.workdir ?? null},
      ${chat.runnerKind ?? 'mangostudio'}, ${chat.runnerTargetId ?? null})
  `.execute(db);
}

async function searchTextOf(id: string): Promise<string> {
  const rows = await sql<{ searchText: string }>`
    SELECT searchText FROM chats WHERE id = ${id}
  `.execute(db);
  const row = rows.rows[0];
  if (!row) throw new Error(`(chats): expected a row with id ${id} | received: none`);
  return row.searchText;
}

beforeEach(async () => {
  sqlite = new SQLiteDatabase(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) });
  await migrateTo(BEFORE);
  await sql`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('user-1', 'user-1', 'user-1@example.test', 0, 0, 0)
  `.execute(db);
});

afterEach(async () => {
  await db.destroy();
});

describe('066_chat_search_text backfill', () => {
  it('folds the title, the workdir folder and the runner label of an existing chat', async () => {
    await seedChat({
      id: 'native',
      title: 'Configuração',
      workdir: '/srv/Projetos/Relatório/',
    });
    await seedChat({
      id: 'vendor',
      title: 'Straße',
      workdir: 'C:\\work\\Harbor',
      runnerKind: 'external',
      runnerTargetId: 'Codex',
    });

    await migrateTo(TARGET);

    expect(await searchTextOf('native')).toBe('configuracao\nrelatorio\nmango');
    expect(await searchTextOf('vendor')).toBe('strasse\nharbor\ncodex');
  });

  it('stores for a chat without a workdir an empty folder field, as a fresh write does', async () => {
    await seedChat({ id: 'bare', title: 'İstanbul' });

    await migrateTo(TARGET);

    expect(await searchTextOf('bare')).toBe('istanbul\n\nmango');
  });

  it('fills every chat when there are more than one batch of them', async () => {
    for (let index = 0; index < 1_203; index++) {
      await seedChat({ id: `chat-${String(index).padStart(5, '0')}`, title: `Título ${index}` });
    }

    await migrateTo(TARGET);

    const unfilled = await sql<{ count: number }>`
      SELECT count(*) AS count FROM chats WHERE searchText = ''
    `.execute(db);
    expect(
      unfilled.rows[0]?.count,
      '(chats.searchText): expected 0 rows left empty after the backfill'
    ).toBe(0);
    expect(await searchTextOf('chat-01202')).toBe('titulo 1202\n\nmango');
  });

  it('holds exactly what the live chatSearchKey stores, on a sample that exercises each fold rule', async () => {
    const samples: SeedChat[] = [
      { id: 'a', title: 'CONFIGURAÇÃO' },
      { id: 'b', title: 'Configurac\u0327a\u0303o' },
      { id: 'c', title: 'İSTANBUL ıspanak' },
      { id: 'd', title: 'Straße MÜLLER' },
      { id: 'e', title: 'ΣΑΣ ὈΔΥΣΣΕΎΣ' },
      { id: 'f', title: 'ﬁnal', workdir: '/a/b/' },
      { id: 'g', title: 'x', workdir: '\\\\host\\share\\Pasta' },
      { id: 'h', title: 'y', workdir: '///' },
      { id: 'i', title: 'z', runnerKind: 'external', runnerTargetId: 'cursor' },
    ];
    for (const sample of samples) await seedChat(sample);

    await migrateTo(TARGET);

    for (const sample of samples) {
      expect(
        await searchTextOf(sample.id),
        `(chat ${sample.id}): expected the backfilled text to equal chatSearchKey of ${JSON.stringify(sample)}`
      ).toBe(
        chatSearchKey({
          title: sample.title,
          workdir: sample.workdir ?? null,
          runnerKind: sample.runnerKind ?? 'mangostudio',
          runnerTargetId: sample.runnerTargetId ?? null,
        })
      );
    }
  });

  it('leaves a chat written by an older build findable by nothing, not unreadable', async () => {
    await migrateTo(TARGET);

    // An older build's insert names no `searchText`.
    await seedChat({ id: 'late', title: 'Written after' });

    expect(await searchTextOf('late')).toBe('');
  });
});

describe('066_chat_search_text down', () => {
  it('drops the column and keeps the chats', async () => {
    await seedChat({ id: 'kept', title: 'Kept' });
    await migrateTo(TARGET);

    await migrateTo(BEFORE);

    const columns = await sql<{ name: string }>`PRAGMA table_info(chats)`.execute(db);
    expect(columns.rows.map((column) => column.name)).not.toContain('searchText');
    const rows = await sql<{ id: string }>`SELECT id FROM chats`.execute(db);
    expect(rows.rows).toEqual([{ id: 'kept' }]);
  });
});
