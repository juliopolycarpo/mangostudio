import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';

import { allMigrations } from '../../../src/db/migrations';
import { MigratedDatabaseTemplate } from '../../support/migrated-database-template';
import { ObservedFileDatabase } from '../../support/observed-file-database';

let template: MigratedDatabaseTemplate | undefined;
let directories: string[];
let opened: ObservedFileDatabase[];

beforeAll(async () => {
  template = await MigratedDatabaseTemplate.create('migrated-template-test');
}, 120_000);

afterAll(() => {
  template?.dispose();
});

beforeEach(() => {
  directories = [];
  opened = [];
});

afterEach(async () => {
  for (const database of opened) await database.destroy();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function openCopy(): ObservedFileDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'migrated-template-copy-'));
  directories.push(directory);
  if (!template) throw new Error('expected the migrated template from beforeAll | received: none');
  template.copyInto(directory);
  const database = new ObservedFileDatabase(directory);
  opened.push(database);
  return database;
}

describe('MigratedDatabaseTemplate', () => {
  it('hands out a copy that already carries every migration, without running one', async () => {
    const copy = openCopy();

    const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(
      copy.db
    );

    expect({
      recorded: rows.length,
      // Only the statement above went through Kysely: nothing migrated inside the hook.
      schemaStatements: copy.observed.filter((entry) => /create table|alter table/i.test(entry.sql))
        .length,
    }).toEqual({ recorded: Object.keys(allMigrations).length, schemaStatements: 0 });
  });

  it('hands out independent copies, so a write in one test is not seen by the next', async () => {
    const first = openCopy();
    await sql`CREATE TABLE written_by_first (id TEXT)`.execute(first.db);

    const second = openCopy();
    const { rows } = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE name = 'written_by_first'`.execute(second.db);

    expect(
      rows,
      `expected no table written_by_first in a fresh copy | received: ${rows.length}`
    ).toHaveLength(0);
  });

  it('removes its directory on dispose', async () => {
    const disposable = await MigratedDatabaseTemplate.create('migrated-template-dispose');
    try {
      const directory = mkdtempSync(join(tmpdir(), 'migrated-template-dispose-copy-'));
      directories.push(directory);
      disposable.copyInto(directory);
      const copiedFile = join(directory, 'database.sqlite');
      expect(existsSync(copiedFile), `expected a copy at ${copiedFile}`).toBe(true);

      disposable.dispose();

      expect(() => disposable.copyInto(directory)).toThrow(/ENOENT|no such file/i);
    } finally {
      // Idempotent: removes the template when an assertion above failed before dispose().
      disposable.dispose();
    }
  }, 120_000);
});
