/**
 * Migration 064 replaces the `(userId)` index on `chats` with
 * `(userId, updatedAt DESC)` and drops `idx_chats_updated_at`, which no read
 * uses. The chat list reads one user's chats newest
 * first; with `userId` alone SQLite loaded every row, state blobs included,
 * into a temp B-tree and sorted them. The plan is read from the exact SQL and
 * parameters `listByUserId` sends, so a reshaped query that stops matching the
 * index fails here. The hub never runs `ANALYZE`, so these heuristic plans are
 * the ones a real database gets.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type CompiledQuery, Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import {
  getById,
  getByIdWithState,
  getOwnedChat,
  listByIdsForUser,
  listOtherChatBindings,
  listPageByUserId,
  verifyChatOwnership,
} from '../../../src/modules/chats/infrastructure/chat-repository';
import { updateChatAfterTurn } from '../../../src/modules/generation/infrastructure/conversation-persistence';

const TARGET = '064_chats_user_updated_index';
const PREVIOUS = '063_messages_ordered_read_indexes';
const NEW_INDEX = 'idx_chats_user_id_updated_at';
const REPLACED_INDEX = 'chats_userId_idx';
const DROPPED_INDEX = 'idx_chats_updated_at';

const OWNER = 'user-owner';
const OTHER = 'user-other';
const STATE_COLUMNS = ['lastProviderState', 'lastContextState'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrating incrementally through schemas `Database` does not describe.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;
let executed: CompiledQuery[];

function typedDb(): Kysely<Database> {
  return db as Kysely<Database>;
}

async function migrateTo(name: string): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });
  const { error } = await migrator.migrateTo(name);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- The migration error is rethrown unchanged so the test observes the original failure.
  if (error) throw error;
}

async function indexSql(name: string): Promise<string | null> {
  const result = await sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`.execute(db);
  return result.rows[0]?.sql ?? null;
}

/** The whole list in one page, the way the old unpaged read returned it. */
async function listByUserId(userId: string, database: Kysely<Database>) {
  return (await listPageByUserId(userId, { limit: 1_000 }, database)).chats;
}

/** Plans one captured query on a fresh statement, as the dialect prepares one per query. */
function planOf(query: CompiledQuery): string[] {
  const statement = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
  const rows = statement.all(...(query.parameters as never[])) as { detail: string }[];
  statement.finalize();
  return rows.map((row) => row.detail);
}

/** The one `chats` read a production call sent, as executed. */
async function capturedChatsRead(read: () => Promise<unknown>): Promise<CompiledQuery> {
  executed = [];
  await read();
  const reads = executed.filter((query) => /^select .* from "chats"/.test(query.sql));
  if (reads.length !== 1) {
    throw new Error(
      `expected chats reads: 1 | received: ${reads.length} (${JSON.stringify(
        executed.map((query) => query.sql)
      )})`
    );
  }
  return reads[0] as CompiledQuery;
}

/** Every statement a production call sent against `chats`, as executed. */
async function capturedChatsStatements(read: () => Promise<unknown>): Promise<CompiledQuery[]> {
  executed = [];
  await read();
  const statements = executed.filter((query) => /(from|update) "chats"/.test(query.sql));
  if (statements.length === 0) {
    throw new Error(
      `expected statements on chats: at least 1 | received: 0 (${JSON.stringify(
        executed.map((query) => query.sql)
      )})`
    );
  }
  return statements;
}

/**
 * Seeds 40 chats for the owner and 10 for another user. Every fourth owner chat
 * shares its `updatedAt` with its neighbours, so the order of ties is part of
 * what the tests compare. Half the owner's chats carry state blobs.
 */
async function seedChats(): Promise<void> {
  for (let index = 0; index < 50; index++) {
    const owner = index < 40 ? OWNER : OTHER;
    const hasState = index % 2 === 0;
    await sql`INSERT INTO chats (id, title, createdAt, updatedAt, userId, workdir, lastProviderState, lastContextState)
      VALUES (
        ${`chat-${String(index).padStart(2, '0')}`},
        ${`Chat ${index}`},
        ${1_000 + index},
        ${5_000 + Math.floor(index / 4)},
        ${owner},
        ${index % 3 === 0 ? `/work/${index}` : null},
        ${hasState ? JSON.stringify({ cursor: `cursor-${index}`.repeat(50) }) : null},
        ${hasState ? JSON.stringify({ estimatedInputTokens: index }) : null}
      )`.execute(db);
  }
}

/** The list as it was read before the migration (`selectAll` and a sort, owner only), under the order the list now defines. */
async function listWithPreviousQuery(): Promise<Record<string, unknown>[]> {
  return (await typedDb()
    .selectFrom('chats')
    .selectAll()
    .where('userId', '=', OWNER)
    .orderBy('updatedAt', 'desc')
    .orderBy(sql`rowid`, 'asc')
    .execute()) as unknown as Record<string, unknown>[];
}

beforeEach(() => {
  sqlite = new SQLiteDatabase(':memory:');
  executed = [];
  db = new Kysely({
    dialect: createBunSqliteDialect(sqlite),
    log: (event) => {
      if (event.level === 'query') executed.push(event.query);
    },
  });
});

afterEach(() => {
  sqlite.close();
});

describe('064_chats_user_updated_index', () => {
  it('replaces the userId index with a (userId, updatedAt DESC) one', async () => {
    await migrateTo(PREVIOUS);
    expect(await indexSql(REPLACED_INDEX)).not.toBeNull();

    await migrateTo(TARGET);

    expect(await indexSql(NEW_INDEX)).toBe(
      `CREATE INDEX ${NEW_INDEX} ON chats (userId, updatedAt DESC)`
    );
    expect(await indexSql(REPLACED_INDEX)).toBeNull();
  });

  it('drops the updatedAt-only index, which nothing reads', async () => {
    await migrateTo(PREVIOUS);
    expect(await indexSql(DROPPED_INDEX)).not.toBeNull();

    await migrateTo(TARGET);

    expect(await indexSql(DROPPED_INDEX)).toBeNull();
  });

  it('restores the userId index and drops the new one on the way down', async () => {
    await migrateTo(TARGET);

    await migrateTo(PREVIOUS);

    expect(await indexSql(REPLACED_INDEX)).toBe(
      `CREATE INDEX "${REPLACED_INDEX}" on "chats" ("userId")`
    );
    expect(await indexSql(NEW_INDEX)).toBeNull();
  });

  it('recreates the updatedAt-only index on the way down exactly as 004 made it', async () => {
    await migrateTo(PREVIOUS);
    const original = await indexSql(DROPPED_INDEX);
    expect(original).toBe(`CREATE INDEX "${DROPPED_INDEX}" on "chats" ("updatedAt")`);

    await migrateTo(TARGET);
    await migrateTo(PREVIOUS);

    expect(await indexSql(DROPPED_INDEX)).toBe(original);
  });

  it('lists the same chats in the same order, ties by rowid, before and after', async () => {
    await migrateTo(PREVIOUS);
    await seedChats();
    const before = await listWithPreviousQuery();
    // Guards against a vacuous comparison: the seed must contain ties and state.
    const updatedAts = before.map((row) => row.updatedAt);
    expect(new Set(updatedAts).size).toBeLessThan(updatedAts.length);
    expect(before.filter((row) => row.lastProviderState !== null)).toHaveLength(20);
    expect(before).toHaveLength(40);

    await migrateTo(TARGET);
    const afterWithPreviousQuery = await listWithPreviousQuery();
    const listed = await listByUserId(OWNER, typedDb());

    const previousIds = before.map((row) => String(row.id));
    expect(afterWithPreviousQuery.map((row) => String(row.id))).toEqual(previousIds);
    expect(listed.map((chat) => chat.id)).toEqual(previousIds);
    // The tie order is the query's, not the planner's: chats sharing a millisecond list oldest insert first.
    for (const [position, chat] of listed.entries()) {
      const next = listed[position + 1];
      if (next?.updatedAt === chat.updatedAt) expect(chat.id < next.id).toBe(true);
    }
    for (const [position, chat] of listed.entries()) {
      const row = before[position] as Record<string, unknown>;
      expect(chat).toMatchObject({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        workdir: row.workdir,
        userId: row.userId,
        lastProviderState: row.lastProviderState,
        lastContextState: row.lastContextState,
      });
    }
  });
});

describe('the chat list plan', () => {
  it('sorts in a temp B-tree before the migration', async () => {
    await migrateTo(PREVIOUS);

    const plan = planOf(await capturedChatsRead(() => listByUserId(OWNER, typedDb())));

    expect(plan).toEqual([
      `SEARCH chats USING INDEX ${REPLACED_INDEX} (userId=?)`,
      'USE TEMP B-TREE FOR ORDER BY',
    ]);
  });

  it('walks the index in order after the migration', async () => {
    await migrateTo(TARGET);

    const plan = planOf(await capturedChatsRead(() => listByUserId(OWNER, typedDb())));

    expect(plan).toEqual([`SEARCH chats USING INDEX ${NEW_INDEX} (userId=?)`]);
  });

  it('seeks to the cursor on the index, without a sort, for a later page', async () => {
    await migrateTo(TARGET);

    const plan = planOf(
      await capturedChatsRead(() =>
        listPageByUserId(OWNER, { limit: 50, after: { updatedAt: 5_005, rowid: 20 } }, typedDb())
      )
    );

    expect(plan).toEqual([`SEARCH chats USING INDEX ${NEW_INDEX} (userId=? AND updatedAt<?)`]);
  });
});

describe('paging the chat list', () => {
  it('joins pages into the same list as one read, ties included', async () => {
    await migrateTo(TARGET);
    await seedChats();
    const whole = (await listByUserId(OWNER, typedDb())).map((chat) => chat.id);

    for (const limit of [1, 3, 4, 7, 40, 41]) {
      const ids: string[] = [];
      let after: { updatedAt: number; rowid: number } | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const slice = await listPageByUserId(
          OWNER,
          { limit, ...(after ? { after } : {}) },
          typedDb()
        );
        ids.push(...slice.chats.map((chat) => chat.id));
        const last = slice.chats.at(-1);
        if (!slice.hasMore || !last) break;
        after = { updatedAt: last.updatedAt, rowid: last.rowid };
      }
      expect(ids, `(limit ${limit}): expected the pages to join into the whole list`).toEqual(
        whole
      );
    }
  });

  it('reports hasMore only when a chat follows the page', async () => {
    await migrateTo(TARGET);
    await seedChats();

    const exact = await listPageByUserId(OWNER, { limit: 40 }, typedDb());
    const short = await listPageByUserId(OWNER, { limit: 39 }, typedDb());

    expect(exact).toMatchObject({ hasMore: false });
    expect(exact.chats).toHaveLength(40);
    expect(short).toMatchObject({ hasMore: true });
    expect(short.chats).toHaveLength(39);
  });
});

describe('chats statements without idx_chats_updated_at', () => {
  const OTHER_ID = 'chat-00';
  const reads: [string, () => Promise<unknown>][] = [
    ['the chat list', () => listByUserId(OWNER, typedDb())],
    ['getById', () => getById(OTHER_ID, typedDb())],
    ['getByIdWithState', () => getByIdWithState(OTHER_ID, typedDb())],
    ['getOwnedChat', () => getOwnedChat(OTHER_ID, OWNER, typedDb())],
    ['listByIdsForUser', () => listByIdsForUser([OTHER_ID], OWNER, typedDb())],
    ['listOtherChatBindings', () => listOtherChatBindings(OWNER, 'local', OTHER_ID, typedDb())],
    ['verifyChatOwnership', () => verifyChatOwnership(OTHER_ID, OWNER, typedDb())],
    // The image turn and createMessage write recency through the same statement.
    [
      'the recency update after a turn',
      () => updateChatAfterTurn(OTHER_ID, OWNER, 9_000, typedDb()),
    ],
  ];

  it.each(reads)('%s does not use it before the migration', async (_label, read) => {
    await migrateTo(PREVIOUS);

    const plans = (await capturedChatsStatements(read)).flatMap(planOf);

    expect(plans.filter((line) => line.includes(DROPPED_INDEX))).toEqual([]);
  });

  it.each(reads)('%s stays an index or key search after the migration', async (_label, read) => {
    await migrateTo(TARGET);

    const plans = (await capturedChatsStatements(read)).flatMap(planOf);

    expect(plans.filter((line) => line.startsWith('SCAN chats'))).toEqual([]);
    expect(plans.some((line) => line.startsWith('SEARCH chats'))).toBe(true);
  });
});

describe('the columns a chat read selects', () => {
  it('leaves the state blobs out of getById and keeps the chat the same', async () => {
    await migrateTo(TARGET);
    await seedChats();

    const query = await capturedChatsRead(() => getById('chat-00', typedDb()));
    const chat = await getById('chat-00', typedDb());

    for (const column of STATE_COLUMNS) expect(query.sql).not.toContain(column);
    expect(chat).toMatchObject({ id: 'chat-00', title: 'Chat 0', workdir: '/work/0' });
    expect(chat).not.toHaveProperty('lastProviderState');
    expect(chat).not.toHaveProperty('lastContextState');
  });

  it('reads the state blobs in getByIdWithState and in the list', async () => {
    await migrateTo(TARGET);
    await seedChats();

    const single = await capturedChatsRead(() => getByIdWithState('chat-00', typedDb()));
    const list = await capturedChatsRead(() => listByUserId(OWNER, typedDb()));
    const withState = await getByIdWithState('chat-00', typedDb());
    const withoutState = await getByIdWithState('chat-01', typedDb());

    for (const query of [single, list]) {
      for (const column of STATE_COLUMNS) expect(query.sql).toContain(column);
    }
    expect(withState?.lastContextState).toBe(JSON.stringify({ estimatedInputTokens: 0 }));
    expect(withoutState).toMatchObject({ lastProviderState: null, lastContextState: null });
  });

  it('returns undefined for a chat that does not exist', async () => {
    await migrateTo(TARGET);

    expect(await getById('missing', typedDb())).toBeUndefined();
    expect(await getByIdWithState('missing', typedDb())).toBeUndefined();
  });
});
