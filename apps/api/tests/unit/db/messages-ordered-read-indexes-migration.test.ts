/**
 * Migration 063 swaps two messages indexes for ones that hold the order their
 * reads ask for. The point is the plan: SQLite can skip the temp B-tree sort,
 * and the read of every candidate row before it, only when an index supplies
 * the `ORDER BY`. Plans are read from the exact SQL and parameters the
 * production functions send, so a reshaped query that stops matching an index
 * fails here. The hub never runs `ANALYZE`, so these heuristic plans are the
 * ones a real database gets.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type CompiledQuery, Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import type { GalleryCursor } from '../../../src/modules/messages/domain/gallery-cursor';
import {
  decodeTranscriptCursor,
  type TranscriptCursor,
} from '../../../src/modules/messages/domain/transcript-cursor';
import {
  listByChatId,
  listLegacyGalleryImages,
  loadHistory,
  loadRichHistory,
} from '../../../src/modules/messages/infrastructure/message-repository';

const TARGET = '063_messages_ordered_read_indexes';
const PREVIOUS = '062_environment_toolchain_revision';
const CHAT_INDEX = 'idx_messages_chat_id_timestamp';
const GALLERY_INDEX = 'idx_messages_role_timestamp_image';
const REPLACED_CHAT_INDEX = 'idx_messages_chat_id';
const REPLACED_GALLERY_INDEX = 'idx_messages_role_image_url_timestamp';

const USER_ID = 'user-1';
const CHAT_ID = 'chat-1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrating incrementally through schemas `Database` does not describe.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;
let executed: CompiledQuery[];

function typedDb(): Kysely<Database> {
  return db as Kysely<Database>;
}

function migrator(): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(allMigrations) } });
}

async function migrateTo(name: string): Promise<void> {
  const { error } = await migrator().migrateTo(name);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- The migration error is rethrown unchanged so the test observes the original failure.
  if (error) throw error;
}

async function indexSql(name: string): Promise<string | null> {
  const result = await sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`.execute(db);
  return result.rows[0]?.sql ?? null;
}

/** Plans one captured query on a fresh statement, as the dialect prepares one per query. */
function planOf(query: CompiledQuery): string[] {
  const statement = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
  const rows = statement.all(...(query.parameters as never[])) as { detail: string }[];
  statement.finalize();
  return rows.map((row) => row.detail);
}

/** The one ordered messages read a production call sent, as executed. */
async function capturedOrderedRead(read: () => Promise<unknown>): Promise<CompiledQuery> {
  executed = [];
  await read();
  const reads = executed.filter(
    (query) => /^select .* from "messages"/.test(query.sql) && query.sql.includes(' order by ')
  );
  if (reads.length !== 1) {
    throw new Error(
      `expected ordered messages reads: 1 | received: ${reads.length} (${JSON.stringify(
        executed.map((query) => query.sql)
      )})`
    );
  }
  return reads[0] as CompiledQuery;
}

/** Ids of the seeded `ai` image rows: m01 and m02 share a timestamp. */
const SEEDED_IMAGE_IDS = ['m01', 'm02', 'm05', 'm08', 'm11', 'm14'];

/**
 * Seeds one chat with timestamp ties (rows 3k..3k+2 share a millisecond), the
 * image turns in {@link SEEDED_IMAGE_IDS}, a compaction boundary on m07, and a
 * user image row that never enters the gallery.
 */
async function seedChat(): Promise<void> {
  await sql`INSERT INTO chats (id, title, createdAt, updatedAt, userId)
    VALUES (${CHAT_ID}, 'chat', 1, 1, ${USER_ID})`.execute(db);
  for (let index = 0; index < 15; index++) {
    const id = `m${String(index).padStart(2, '0')}`;
    const isImage = SEEDED_IMAGE_IDS.includes(id);
    await sql`INSERT INTO messages (id, chatId, role, text, imageUrl, timestamp, isGenerating, interactionMode, parts)
      VALUES (
        ${id},
        ${CHAT_ID},
        ${isImage || index % 2 === 1 ? 'ai' : 'user'},
        ${`text ${index}`},
        ${isImage ? `/img/${index}.png` : null},
        ${1_000 + Math.floor(index / 3)},
        0,
        ${isImage ? 'image' : 'agent'},
        ${index === 7 ? JSON.stringify([{ type: 'system_event', event: 'chat_compacted' }]) : null}
      )`.execute(db);
  }
  // `role` is not `ai` for this one, so it never enters the gallery.
  await sql`INSERT INTO messages (id, chatId, role, text, imageUrl, timestamp, isGenerating, interactionMode)
    VALUES ('ref', ${CHAT_ID}, 'user', 'reference', '/img/ref.png', 999, 0, 'image')`.execute(db);
}

/** Every page of a transcript walk, three rows at a time. */
async function walkTranscript(order: 'asc' | 'desc'): Promise<unknown[]> {
  const pages: unknown[] = [];
  let cursor: TranscriptCursor | undefined;
  for (;;) {
    const page = await listByChatId(CHAT_ID, { limit: 3, order, cursor }, typedDb());
    pages.push(page);
    if (!page.nextCursor) return pages;
    cursor = decodeTranscriptCursor(page.nextCursor, order);
  }
}

/** Every page of the legacy gallery, two images at a time; the look-ahead row is dropped. */
async function walkGallery(): Promise<unknown[]> {
  const pages: unknown[] = [];
  let cursor: GalleryCursor | undefined;
  for (;;) {
    const entries = await listLegacyGalleryImages(USER_ID, { limit: 2, cursor }, typedDb());
    const page = entries.slice(0, 2);
    pages.push(page);
    const last = page.at(-1);
    if (entries.length <= 2 || !last) return pages;
    cursor = { createdAt: last.item.createdAt, source: last.source, rowid: last.rowid };
  }
}

/** Everything the reads under test return for the seeded chat. */
async function readEverything(): Promise<unknown> {
  return {
    asc: await walkTranscript('asc'),
    desc: await walkTranscript('desc'),
    history: await loadHistory(CHAT_ID, { limit: 8, excludeId: 'm13' }, typedDb()),
    richHistory: await loadRichHistory(CHAT_ID, { limit: 8, excludeIds: ['m13'] }, typedDb()),
    gallery: await walkGallery(),
  };
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

describe('063_messages_ordered_read_indexes', () => {
  it('replaces the chatId and gallery indexes with ordered ones', async () => {
    await migrateTo(PREVIOUS);
    expect(await indexSql(REPLACED_CHAT_INDEX)).not.toBeNull();
    expect(await indexSql(REPLACED_GALLERY_INDEX)).not.toBeNull();

    await migrateTo(TARGET);

    expect(await indexSql(CHAT_INDEX)).toBe(
      `CREATE INDEX "${CHAT_INDEX}" on "messages" ("chatId", "timestamp")`
    );
    expect(await indexSql(GALLERY_INDEX)).toBe(
      `CREATE INDEX "${GALLERY_INDEX}" on "messages" ("role", "timestamp") where "imageUrl" is not null`
    );
    expect(await indexSql(REPLACED_CHAT_INDEX)).toBeNull();
    expect(await indexSql(REPLACED_GALLERY_INDEX)).toBeNull();
  });

  it('restores the replaced indexes and drops the new ones on the way down', async () => {
    await migrateTo(TARGET);

    await migrateTo(PREVIOUS);

    expect(await indexSql(REPLACED_CHAT_INDEX)).toBe(
      `CREATE INDEX "${REPLACED_CHAT_INDEX}" on "messages" ("chatId")`
    );
    expect(await indexSql(REPLACED_GALLERY_INDEX)).toBe(
      `CREATE INDEX "${REPLACED_GALLERY_INDEX}" on "messages" ("role", "imageUrl", "timestamp")`
    );
    expect(await indexSql(CHAT_INDEX)).toBeNull();
    expect(await indexSql(GALLERY_INDEX)).toBeNull();
  });

  it('returns the same pages, histories and gallery before and after the swap', async () => {
    await migrateTo(PREVIOUS);
    await seedChat();
    const before = await readEverything();
    // Guards against a vacuous comparison: the seed must reach every read.
    const seeded = before as {
      history: { id: string }[];
      gallery: { item: { id: string } }[][];
    };
    expect(seeded.history.map((turn) => turn.id)).toEqual(['m07', 'm09', 'm10', 'm12']);
    expect(seeded.gallery.flat().map((entry) => entry.item.id)).toEqual(
      [...SEEDED_IMAGE_IDS].reverse()
    );

    await migrateTo(TARGET);
    const after = await readEverything();

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

describe('ordered messages reads after 063', () => {
  const desc = 'desc' as const;
  const transcriptCursor = { timestamp: 1_002, rowid: 7 };
  const galleryCursor: GalleryCursor = { createdAt: 1_003, source: 'message', rowid: 9 };

  const reads: [string, () => Promise<unknown>, string][] = [
    [
      'a transcript page from the oldest row',
      () => listByChatId(CHAT_ID, { limit: 50 }, typedDb()),
      CHAT_INDEX,
    ],
    [
      'a transcript page from the newest row',
      () => listByChatId(CHAT_ID, { limit: 50, order: desc }, typedDb()),
      CHAT_INDEX,
    ],
    [
      'the next oldest-first transcript page',
      () => listByChatId(CHAT_ID, { limit: 50, cursor: transcriptCursor }, typedDb()),
      CHAT_INDEX,
    ],
    [
      'the next newest-first transcript page',
      () => listByChatId(CHAT_ID, { limit: 50, order: desc, cursor: transcriptCursor }, typedDb()),
      CHAT_INDEX,
    ],
    ['the text history', () => loadHistory(CHAT_ID, { excludeId: 'm0' }, typedDb()), CHAT_INDEX],
    [
      'the rich history',
      () => loadRichHistory(CHAT_ID, { excludeIds: ['m0', 'm1'] }, typedDb()),
      CHAT_INDEX,
    ],
    [
      'the first gallery page',
      () => listLegacyGalleryImages(USER_ID, { limit: 50 }, typedDb()),
      GALLERY_INDEX,
    ],
    [
      'the next gallery page',
      () => listLegacyGalleryImages(USER_ID, { limit: 50, cursor: galleryCursor }, typedDb()),
      GALLERY_INDEX,
    ],
  ];

  it.each(reads)('%s sorts in a temp B-tree before the migration', async (_label, read) => {
    await migrateTo(PREVIOUS);

    const plan = planOf(await capturedOrderedRead(read));

    expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it.each(reads)('%s walks the index in order after the migration', async (_label, read, index) => {
    await migrateTo(TARGET);

    const plan = planOf(await capturedOrderedRead(read));

    const sorts = plan.filter((line) => line.includes('TEMP B-TREE'));
    if (sorts.length > 0) {
      throw new Error(`expected plan without a temp B-tree | received: ${JSON.stringify(plan)}`);
    }
    // The outer read is the first line; the gallery's correlated subqueries follow it.
    expect(plan[0]).toStartWith(
      `SEARCH ${index === GALLERY_INDEX ? 'ai' : 'messages'} USING INDEX ${index} (`
    );
  });
});
