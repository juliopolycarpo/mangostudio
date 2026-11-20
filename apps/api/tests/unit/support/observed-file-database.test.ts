import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObservedFileDatabase } from '../../support/observed-file-database';
import { removeFixtureDirSync } from '../../support/remove-fixture-dir';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'observed-file-database-'));
});

afterEach(() => {
  removeFixtureDirSync({ role: 'observed-file-database', path: directory });
});

describe('ObservedFileDatabase.destroy', () => {
  it('closes the database file even when no query went through Kysely', async () => {
    // Kysely opens its driver on the first query, and closes the database only if it did.
    const file = new ObservedFileDatabase(directory);

    await file.destroy();

    let received = 'the handle still answered a query';
    try {
      file.sqlite.query('SELECT 1').get();
    } catch (error) {
      received = String(error);
    }
    expect(received, `expected a closed database | received: ${received}`).toContain('closed');
  });
});
