/**
 * The writes that record an intent before something the database cannot undo
 * commit at synchronous = FULL on a relaxed (NORMAL) hub database; ordinary
 * writes next to them do not. The level is read from the connection after each
 * statement, so each assertion names the write that ran at it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Migrator } from 'kysely/migration';

import { relaxDurability } from '../../../src/db/durability';
import { allMigrations } from '../../../src/db/migrations';
import {
  insertAttempt,
  transitionAttempt,
} from '../../../src/modules/external-agents/infrastructure/external-turn-attempt-repository';
import { createDatabaseCheckpointStore } from '../../../src/modules/generation/application/turn-checkpoint';
import { insertMessage } from '../../../src/modules/messages/infrastructure/message-repository';
import { MigratedDatabaseTemplate } from '../../support/migrated-database-template';
import {
  ObservedFileDatabase,
  SYNCHRONOUS_FULL as FULL,
  SYNCHRONOUS_NORMAL as NORMAL,
} from '../../support/observed-file-database';

let directory: string;
let file: ObservedFileDatabase;
let migrated: MigratedDatabaseTemplate | undefined;

// Migrating a fresh file costs one fsync per statement (see MigratedDatabaseTemplate), so
// migrate once and give each test a copy of the finished file.
beforeAll(async () => {
  migrated = await MigratedDatabaseTemplate.create('durable-markers');
}, 120_000);

afterAll(() => {
  migrated?.dispose();
});

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'durable-markers-'));
  if (!migrated) throw new Error('expected the migrated template from beforeAll | received: none');
  migrated.copyInto(directory);
  file = new ObservedFileDatabase(directory);
  // `runMigrations` lowers the level on its own connection; this connection starts at FULL.
  await relaxDurability(file.db);
  // These tests look at pragma levels, not at relations: no chat or message rows are seeded.
  file.sqlite.exec('PRAGMA foreign_keys = OFF');
  file.forget();
});

afterEach(async () => {
  await file.destroy();
  rmSync(directory, { recursive: true, force: true });
});

describe('the external-turn receipt', () => {
  it('is committed at FULL, and its later transition at NORMAL', async () => {
    await insertAttempt(
      {
        id: 'attempt-1',
        messageId: 'message-1',
        chatId: 'chat-1',
        userId: 'user-1',
        environmentId: 'local',
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        inputFingerprint: 'sha256:0',
        createdAt: 1,
        updatedAt: 1,
      },
      file.db
    );
    await transitionAttempt('attempt-1', ['acceptance-unknown'], 'accepted', { at: 2 }, file.db);

    expect({
      receipt: file.levelOf(/insert into "external_turn_attempts"/i),
      transition: file.levelOf(/update "external_turn_attempts"/i),
      afterwards: file.level(),
    }).toEqual({ receipt: FULL, transition: NORMAL, afterwards: NORMAL });
  });
});

/**
 * A durable checkpoint is only stored for a row that is still generating, so the stores below
 * need one. Foreign keys are off, so no chat is needed; the insert is forgotten so it is not
 * mistaken for the write a test observes.
 */
async function seedGeneratingMessage(target: ObservedFileDatabase, id: string): Promise<void> {
  await insertMessage(
    {
      id,
      chatId: 'chat-1',
      role: 'ai',
      text: '',
      timestamp: 1,
      isGenerating: true,
      interactionMode: 'agent',
    },
    target.db
  );
  target.forget();
}

describe('the database checkpoint store', () => {
  const row = { text: 'a', partsJson: '[]', providerState: null, generationTime: null };

  beforeEach(async () => {
    await seedGeneratingMessage(file, 'message-1');
  });

  it('commits a durable delta at FULL and an ordinary one at NORMAL', async () => {
    const store = createDatabaseCheckpointStore(file.db, 'message-1');

    await store.appendDelta(1, '{}', { durable: true });
    await store.appendDelta(2, '{}', { durable: false });

    const deltaInserts = file.observed.filter((entry) =>
      /insert into "message_checkpoint_deltas"/i.test(entry.sql)
    );
    expect({
      levels: deltaInserts.map((entry) => entry.synchronous),
      afterwards: file.level(),
    }).toEqual({
      levels: [FULL, NORMAL],
      afterwards: NORMAL,
    });
  });

  it('commits a durable full-row rewrite, and its transaction, at FULL', async () => {
    const store = createDatabaseCheckpointStore(file.db, 'message-1');

    await store.rewriteRow(row, { durable: true });

    expect({
      update: file.levelOf(/update "messages"/i),
      cleanup: file.levelOf(/delete from "message_checkpoint_deltas"/i),
      afterwards: file.level(),
    }).toEqual({ update: FULL, cleanup: FULL, afterwards: NORMAL });
  });

  it('writes a rewrite that is not durable at NORMAL', async () => {
    const store = createDatabaseCheckpointStore(file.db, 'message-1');

    await store.rewriteRow(row, { durable: false });

    expect(file.levelOf(/update "messages"/i)).toBe(NORMAL);
  });
});

describe('a database that was never relaxed', () => {
  it('commits a durable checkpoint without touching the pragma', async () => {
    const unrelaxedDirectory = mkdtempSync(join(tmpdir(), 'durable-markers-unrelaxed-'));
    const unrelaxed = new ObservedFileDatabase(unrelaxedDirectory);
    try {
      await runMigrationsWithoutRelaxing(unrelaxed);
      unrelaxed.sqlite.exec('PRAGMA foreign_keys = OFF');
      await seedGeneratingMessage(unrelaxed, 'message-1');

      await createDatabaseCheckpointStore(unrelaxed.db, 'message-1').appendDelta(1, '{}', {
        durable: true,
      });

      expect(unrelaxed.observed.some((entry) => /PRAGMA synchronous\s*=/i.test(entry.sql))).toBe(
        false
      );
    } finally {
      await unrelaxed.destroy();
      rmSync(unrelaxedDirectory, { recursive: true, force: true });
    }
  });
});

/** Applies the schema through the migrator without the lowering `runMigrations` adds. */
async function runMigrationsWithoutRelaxing(target: ObservedFileDatabase): Promise<void> {
  const { error } = await new Migrator({
    db: target.db,
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  }).migrateToLatest();
  if (error) throw new Error('expected every migration to apply', { cause: error });
}
