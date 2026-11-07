import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireCaptureLock } from '../../../src/backup/capture-lock';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mango-lock-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function createDatabase(path: string): void {
  const database = new Database(path);
  database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('keep')");
  database.close();
}

async function lockOutcome(path: string): Promise<string> {
  try {
    const release = await acquireCaptureLock(path);
    await release();
    return 'acquired';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('capture ownership paths', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a dangling database symlink without taking ownership under the alias',
    async () => {
      const database = join(directory, 'database.sqlite');
      await symlink(join(directory, 'missing.sqlite'), database);
      expect(await lockOutcome(database)).toContain('dangling database symlink');
    }
  );

  it('refuses a multiply linked database whose aliases would have separate lock files', async () => {
    const database = join(directory, 'database.sqlite');
    const alias = join(directory, 'alias.sqlite');
    createDatabase(database);
    await link(database, alias);
    expect(await lockOutcome(database)).toContain('single-link regular database file');
    expect(await lockOutcome(alias)).toContain('single-link regular database file');
  });

  it.skipIf(process.platform === 'win32')(
    'uses the physical database parent for a path whose final file does not exist',
    async () => {
      const lexical = join(directory, 'lexical');
      const physical = join(directory, 'physical');
      await mkdir(lexical);
      await mkdir(join(physical, 'sub'), { recursive: true });
      await symlink(join(physical, 'sub'), join(lexical, 'link'), 'dir');
      const path = `${lexical}/link/../database.sqlite`;
      const release = await acquireCaptureLock(path);
      try {
        expect(await lockOutcome(join(physical, 'database.sqlite'))).toContain(
          'capture lock cannot be acquired'
        );
      } finally {
        await release();
      }
    }
  );

  for (const kind of ['symlink', 'hard link'] as const) {
    it.skipIf(kind === 'symlink' && process.platform === 'win32')(
      `leaves a ${kind} at the lock path and its target untouched`,
      async () => {
        const database = join(directory, 'database.sqlite');
        const unrelated = join(directory, 'unrelated.sqlite');
        createDatabase(unrelated);
        await chmod(unrelated, 0o644);
        const originalMode = (await stat(unrelated)).mode;
        const lockPath = `${database}.capture-lock.sqlite`;
        if (kind === 'symlink') await symlink(unrelated, lockPath);
        else await link(unrelated, lockPath);
        expect(await lockOutcome(database)).toContain('single-link regular lock file');
        expect((await stat(unrelated)).mode).toBe(originalMode);
      }
    );
  }
});
