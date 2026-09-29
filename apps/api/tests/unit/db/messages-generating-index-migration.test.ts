/**
 * Migration 058 adds a partial index over generating messages, and the
 * recovery scans that run at boot and every sweep interval must actually use
 * it. The plan is read from the exact SQL and parameters the production
 * functions send, against a real (in-memory) SQLite engine, so a reshaped
 * query that stops matching the index fails here.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type CompiledQuery, Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import { reconcileExternalTurns } from '../../../src/modules/external-agents/application/external-turn-recovery';
import { reconcileStaleTurns } from '../../../src/modules/generation/application/turn-recovery';

const TARGET = '058_messages_generating_index';
const PREVIOUS = '057_drop_attempt_connection_revision';
const INDEX = 'idx_messages_generating';

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

async function indexSql(): Promise<string | null> {
  const result = await sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${INDEX}`.execute(db);
  return result.rows[0]?.sql ?? null;
}

/** The one generating-message scan a recovery pass sent, as executed. */
function capturedRecoveryScan(): CompiledQuery {
  const scans = executed.filter(
    (query) =>
      /^select .* from "messages" where /.test(query.sql) && query.sql.includes('"isGenerating"')
  );
  if (scans.length !== 1) {
    throw new Error(
      `expected captured recovery scan: 1 | received: ${scans.length} (${JSON.stringify(
        executed.map((query) => query.sql)
      )})`
    );
  }
  return scans[0] as CompiledQuery;
}

/**
 * Plans the captured scan on a fresh statement, as the dialect prepares one
 * per query: SQLite matches a partial index against the bound value, so the
 * plan depends on the parameters, not only on the SQL text.
 */
function planOf(query: CompiledQuery): string[] {
  const statement = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
  const rows = statement.all(...(query.parameters as never[])) as { detail: string }[];
  statement.finalize();
  return rows.map((row) => row.detail);
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

describe('058_messages_generating_index', () => {
  it('creates a partial index holding only generating messages', async () => {
    await migrateTo(PREVIOUS);
    expect(await indexSql()).toBeNull();

    await migrateTo(TARGET);

    expect(await indexSql()).toBe(
      `CREATE INDEX "${INDEX}" on "messages" ("isGenerating") where "isGenerating" = 1`
    );
  });

  it('drops the index on the way down', async () => {
    await migrateTo(TARGET);

    await migrateTo(PREVIOUS);

    expect(await indexSql()).toBeNull();
  });
});

describe('generating-message recovery scans', () => {
  const expectedPlan = [`SEARCH messages USING INDEX ${INDEX} (isGenerating=?)`];

  beforeEach(async () => {
    await migrateTo(TARGET);
    executed = [];
  });

  it('boot external-turn recovery reads through the partial index', async () => {
    await reconcileExternalTurns({ reason: 'hub-restarted' }, db);

    expect(planOf(capturedRecoveryScan())).toEqual(expectedPlan);
  });

  it('boot stale-turn recovery reads through the partial index', async () => {
    await reconcileStaleTurns({ reasonCode: 'server_restart' }, db);

    expect(planOf(capturedRecoveryScan())).toEqual(expectedPlan);
  });

  it('the periodic stale-turn sweep reads through the partial index', async () => {
    await reconcileStaleTurns({ reasonCode: 'unknown', isActive: () => false }, db);

    expect(planOf(capturedRecoveryScan())).toEqual(expectedPlan);
  });
});
