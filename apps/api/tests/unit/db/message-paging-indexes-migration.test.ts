/**
 * Migration 059 indexes transcript paging and the attempt orphan scan, and
 * drops `idx_messages_chat_id`, which the new `(chatId, timestamp)` index
 * makes redundant. Three things have to hold, each against a real (in-memory)
 * SQLite engine:
 *
 * - the migration applies to a populated database and reverses cleanly;
 * - the production queries, read from the exact SQL and parameters the
 *   functions send, plan through the new indexes with no sort step;
 * - the rows and their order are the same with and without the indexes.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type CompiledQuery, Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import type { Database } from '../../../src/db/types';
import {
  reconcileExternalTurns,
  sealOrphanedExternalTurnAttempts,
} from '../../../src/modules/external-agents/application/external-turn-recovery';
import { reconcileStaleTurns } from '../../../src/modules/generation/application/turn-recovery';
import {
  decodeTranscriptCursor,
  type TranscriptCursor,
} from '../../../src/modules/messages/domain/transcript-cursor';
import {
  listByChatId,
  loadHistory,
  loadRichHistory,
} from '../../../src/modules/messages/infrastructure/message-repository';

const TARGET = '059_message_paging_indexes';
const PREVIOUS = '058_messages_generating_index';

const TRANSCRIPT_INDEX = 'idx_messages_chat_id_timestamp';
const ATTEMPT_INDEX = 'external_turn_attempts_state';
const SUPERSEDED_INDEX = 'idx_messages_chat_id';

const MAIN_CHAT = 'chat-main';
const OTHER_CHAT = 'chat-other';

// biome-ignore lint/suspicious/noExplicitAny: migrating incrementally through schemas `Database` does not describe.
type AnyDb = Kysely<any>;

let sqlite: SQLiteDatabase;
let db: AnyDb;
let executed: CompiledQuery[];

function migrator(): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(allMigrations) } });
}

async function migrateTo(name: string): Promise<void> {
  const { error } = await migrator().migrateTo(name);
  if (error) throw error;
}

function typed(): Kysely<Database> {
  return db as unknown as Kysely<Database>;
}

async function indexSql(name: string): Promise<string | null> {
  const result = await sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`.execute(db);
  return result.rows[0]?.sql ?? null;
}

async function insertChat(id: string): Promise<void> {
  await sql`INSERT INTO chats (id, title, createdAt, updatedAt) VALUES (${id}, 't', 1, 1)`.execute(
    db
  );
}

async function insertMessage(
  id: string,
  chatId: string,
  timestamp: number,
  mode: 'agent' | 'image'
): Promise<void> {
  await sql`
    INSERT INTO messages (id, chatId, role, text, timestamp, isGenerating, interactionMode)
    VALUES (${id}, ${chatId}, ${timestamp % 2 === 0 ? 'ai' : 'user'}, ${`text ${id}`},
            ${timestamp}, 0, ${mode})
  `.execute(db);
}

async function insertAttempt(id: string, messageId: string, state: string): Promise<void> {
  await sql`
    INSERT INTO external_turn_attempts
      (id, messageId, chatId, userId, environmentId, sessionId, clientMessageId,
       inputFingerprint, state, createdAt, updatedAt)
    VALUES
      (${id}, ${messageId}, ${MAIN_CHAT}, 'u-1', 'local', 's-1', ${`c-${id}`}, 'sha256:0',
       ${state}, 1, 1)
  `.execute(db);
}

/**
 * Seeds the shapes the indexes serve. Timestamps repeat in groups of three
 * (a ties-heavy transcript, so a tie straddles every page and history
 * boundary), the main chat's inserts interleave with another chat's so its
 * rowids are not contiguous, and image turns sit among the text turns.
 */
/** Ids of the main chat's image turns, which text history leaves out. */
function imageTurnIds(): Set<string> {
  return new Set(
    Array.from({ length: 60 }, (_, i) => i)
      .filter((i) => i % 7 === 0)
      .map((i) => `main-${i}`)
  );
}

async function seed(): Promise<void> {
  await insertChat(MAIN_CHAT);
  await insertChat(OTHER_CHAT);
  for (let i = 0; i < 60; i += 1) {
    await insertMessage(
      `main-${i}`,
      MAIN_CHAT,
      1000 + Math.floor(i / 3),
      i % 7 === 0 ? 'image' : 'agent'
    );
    if (i % 3 === 0) await insertMessage(`other-${i}`, OTHER_CHAT, 1000 + i, 'agent');
  }
  for (let i = 0; i < 40; i += 1) await insertAttempt(`done-${i}`, `main-${i}`, 'terminal');
  await insertAttempt('open-orphan', 'missing-message', 'acceptance-unknown');
  await insertAttempt('open-done', 'main-3', 'accepted');
  await insertAttempt('sealed-unresolved', 'main-4', 'unresolved');
}

/** The one `messages` read a call sent, as executed (side lookups excluded). */
function capturedMessagesRead(): CompiledQuery {
  const reads = executed.filter(
    (query) => /^select .* from "messages"/.test(query.sql) && !query.sql.includes('left join')
  );
  if (reads.length !== 1) {
    throw new Error(
      `expected captured messages read: 1 | received: ${reads.length} (${JSON.stringify(
        executed.map((query) => query.sql)
      )})`
    );
  }
  return reads[0] as CompiledQuery;
}

function capturedOrphanScan(): CompiledQuery {
  const scans = executed.filter((query) => query.sql.includes('"external_turn_attempts"'));
  const select = scans.find((query) => query.sql.startsWith('select'));
  if (!select) {
    throw new Error(
      `expected captured orphan scan: 1 select | received: ${JSON.stringify(
        executed.map((query) => query.sql)
      )}`
    );
  }
  return select;
}

/**
 * Plans a captured query on a fresh statement, as the dialect prepares one per
 * query, so the plan reflects the bound parameters.
 */
function planOf(query: CompiledQuery): string[] {
  const statement = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
  const rows = statement.all(...(query.parameters as never[])) as { detail: string }[];
  statement.finalize();
  return rows.map((row) => row.detail);
}

/** Every `messages` and attempt row with its rowid, in rowid order. */
function snapshotRows(): { messages: unknown[]; attempts: unknown[] } {
  return {
    messages: sqlite.prepare('SELECT rowid, * FROM messages ORDER BY rowid').all(),
    attempts: sqlite.prepare('SELECT rowid, * FROM external_turn_attempts ORDER BY rowid').all(),
  };
}

function replay(query: CompiledQuery): unknown[] {
  const statement = sqlite.prepare(query.sql);
  const rows = statement.all(...(query.parameters as never[]));
  statement.finalize();
  return rows;
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

describe('059_message_paging_indexes', () => {
  it('creates both indexes and drops the one the new prefix supersedes', async () => {
    await migrateTo(PREVIOUS);
    expect(await indexSql(SUPERSEDED_INDEX)).not.toBeNull();

    await migrateTo(TARGET);

    expect(await indexSql(TRANSCRIPT_INDEX)).toBe(
      `CREATE INDEX "${TRANSCRIPT_INDEX}" on "messages" ("chatId", "timestamp")`
    );
    expect(await indexSql(ATTEMPT_INDEX)).toBe(
      `CREATE INDEX "${ATTEMPT_INDEX}" on "external_turn_attempts" ("state", "messageId")`
    );
    expect(await indexSql(SUPERSEDED_INDEX)).toBeNull();
  });

  it('applies to a populated database without changing a row', async () => {
    await migrateTo(PREVIOUS);
    await seed();
    const before = snapshotRows();

    await migrateTo(TARGET);

    const after = snapshotRows();
    expect(after.messages.length).toBe(80);
    expect(after).toEqual(before);
    const check = sqlite.prepare('PRAGMA integrity_check').all();
    expect(check).toEqual([{ integrity_check: 'ok' }]);
  });

  it('finishes after a crash that left only some of its statements applied', async () => {
    await migrateTo(PREVIOUS);
    // The adapter has no transactional DDL: a crash after the first statement
    // leaves the first index in place and the migration unrecorded.
    await sql`CREATE INDEX "idx_messages_chat_id_timestamp" on "messages" ("chatId", "timestamp")`.execute(
      db
    );

    await migrateTo(TARGET);

    expect(await indexSql(ATTEMPT_INDEX)).not.toBeNull();
    expect(await indexSql(SUPERSEDED_INDEX)).toBeNull();
  });

  it('restores the superseded index exactly and removes the new ones on the way down', async () => {
    await migrateTo(PREVIOUS);
    const supersededBefore = await indexSql(SUPERSEDED_INDEX);
    await migrateTo(TARGET);

    await migrateTo(PREVIOUS);

    expect(await indexSql(SUPERSEDED_INDEX)).toBe(supersededBefore);
    expect(await indexSql(TRANSCRIPT_INDEX)).toBeNull();
    expect(await indexSql(ATTEMPT_INDEX)).toBeNull();
  });
});

describe('queries after 059', () => {
  const transcriptPlan = [`SEARCH messages USING INDEX ${TRANSCRIPT_INDEX} (chatId=?)`];

  beforeEach(async () => {
    await migrateTo(TARGET);
    await seed();
    executed = [];
  });

  it('the first transcript page reads in order through the index, with no sort', async () => {
    await listByChatId(MAIN_CHAT, { limit: 10 }, typed());

    expect(planOf(capturedMessagesRead())).toEqual(transcriptPlan);
  });

  it('a cursor page seeks within the index, with no sort', async () => {
    await listByChatId(MAIN_CHAT, { limit: 10, cursor: { timestamp: 1005, rowid: 20 } }, typed());

    expect(planOf(capturedMessagesRead())).toEqual([
      `SEARCH messages USING INDEX ${TRANSCRIPT_INDEX} (chatId=? AND timestamp>?)`,
    ]);
  });

  it('simple history, ordered timestamp DESC then rowid DESC, reads through the index with no sort', async () => {
    await loadHistory(MAIN_CHAT, { limit: 10 }, typed());

    expect(planOf(capturedMessagesRead())).toEqual(transcriptPlan);
  });

  it('rich history, ordered timestamp DESC then rowid DESC, reads through the index with no sort', async () => {
    await loadRichHistory(MAIN_CHAT, { limit: 10 }, typed());

    expect(planOf(capturedMessagesRead())).toEqual(transcriptPlan);
  });

  it('the attempt orphan scan finds open attempts through the covering state index', async () => {
    await sealOrphanedExternalTurnAttempts(typed());

    const plan = planOf(capturedOrphanScan());

    expect(plan.filter((line) => line.includes('external_turn_attempts'))).toEqual([
      `SEARCH external_turn_attempts USING COVERING INDEX ${ATTEMPT_INDEX} (state=?)`,
    ]);
    expect(plan.filter((line) => line.includes('ORDER BY'))).toEqual([]);
  });

  it('chat-scoped generating-turn recovery still reads through the partial index', async () => {
    await reconcileExternalTurns({ reason: 'hub-restarted', chatId: MAIN_CHAT }, typed());
    const external = planOf(capturedMessagesRead());
    executed = [];
    await reconcileStaleTurns({ reasonCode: 'server_restart', chatId: MAIN_CHAT }, typed());
    const stale = planOf(capturedMessagesRead());

    expect(external).toEqual([
      'SEARCH messages USING INDEX idx_messages_generating (isGenerating=?)',
    ]);
    expect(stale).toEqual(external);
  });
});

describe('row parity with and without the indexes', () => {
  /** Every transcript page, walked through the cursor until it ends. */
  async function walkTranscript(chatId: string, limit: number): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: TranscriptCursor | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await listByChatId(chatId, { limit, cursor }, typed());
      pages.push(page.messages.map((message) => message.id));
      if (!page.nextCursor) return pages;
      cursor = decodeTranscriptCursor(page.nextCursor);
    }
    throw new Error(`expected transcript walk to end: <= 100 pages | received: still paging`);
  }

  async function readTranscripts(): Promise<Record<string, string[][]>> {
    return {
      [MAIN_CHAT]: await walkTranscript(MAIN_CHAT, 4),
      [OTHER_CHAT]: await walkTranscript(OTHER_CHAT, 4),
    };
  }

  async function readHistories(chatId: string, limit: number): Promise<string[][]> {
    const simple = await loadHistory(chatId, { limit }, typed());
    const rich = await loadRichHistory(chatId, { limit }, typed());
    return [simple.map((turn) => turn.id), rich.map((turn) => turn.id)];
  }

  it('pages every transcript through the cursor in the same order', async () => {
    await migrateTo(PREVIOUS);
    await seed();
    const without = await readTranscripts();

    await migrateTo(TARGET);
    const withIndexes = await readTranscripts();

    expect(withIndexes).toEqual(without);
  });

  it('returns the same history rows in the same order when timestamps are unique', async () => {
    await migrateTo(PREVIOUS);
    await seed();
    const without = await readHistories(OTHER_CHAT, 5);

    await migrateTo(TARGET);
    const withIndexes = await readHistories(OTHER_CHAT, 5);

    expect(withIndexes).toEqual(without);
  });

  // History orders by `timestamp DESC, rowid DESC`, so rows sharing a
  // timestamp have a defined order with or without the index. The limit below
  // cuts a tie group: the newest of the tied rows must be the ones kept, and
  // they must come out oldest first, the same on both sides of the migration.
  it('keeps the newest rows of a tie group a limit splits, in the same order', async () => {
    await migrateTo(PREVIOUS);
    await seed();
    const limit = 9;
    const without = await readHistories(MAIN_CHAT, limit);

    await migrateTo(TARGET);
    const withIndexes = await readHistories(MAIN_CHAT, limit);

    const textTurns = (await walkTranscript(MAIN_CHAT, 100))
      .flat()
      .filter((id) => !imageTurnIds().has(id));
    const kept = textTurns.slice(-limit);
    const group = (id: string): number => Math.floor(Number(id.split('-')[1]) / 3);
    const oldestKept = kept[0] as string;
    const droppedTied = textTurns.slice(0, -limit).filter((id) => group(id) === group(oldestKept));
    expect(droppedTied.length).toBeGreaterThan(0);
    expect(withIndexes).toEqual([kept, kept]);
    expect(without).toEqual(withIndexes);
  });

  it('returns the same open attempts from the orphan scan', async () => {
    await migrateTo(TARGET);
    await sealOrphanedExternalTurnAttempts(typed());
    const scan = capturedOrphanScan();
    await migrateTo(PREVIOUS);
    await seed();
    const sorted = (rows: unknown[]): string[] => rows.map((row) => JSON.stringify(row)).sort();
    const without = sorted(replay(scan));

    await migrateTo(TARGET);
    const withIndex = sorted(replay(scan));

    expect(without.length).toBe(2);
    expect(withIndex).toEqual(without);
  });
});
