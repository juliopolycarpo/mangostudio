/**
 * A revocation commits at synchronous = FULL on a relaxed (NORMAL) hub database:
 * after a power loss a token, key or session the user was told is gone must not
 * come back. The level is read from the connection after each statement, so each
 * assertion names the write that ran at it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';

import type { ApiKeyPluginApi, ApiKeyPluginRecord } from '../../../src/auth';
import { relaxDurability } from '../../../src/db/durability';
import { revokeApiKey } from '../../../src/modules/api-keys/application/api-key-service';
import { createRuntimePairingRepository } from '../../../src/modules/environments/infrastructure/runtime-pairing-repository';
import { handleAuthRequest } from '../../../src/routes/auth';
import { MigratedDatabaseTemplate } from '../../support/migrated-database-template';
import {
  ObservedFileDatabase,
  SYNCHRONOUS_FULL as FULL,
  SYNCHRONOUS_NORMAL as NORMAL,
} from '../../support/observed-file-database';
import { removeFixtureDirSync } from '../../support/remove-fixture-dir';

let directory: string;
let file: ObservedFileDatabase;
let migrated: MigratedDatabaseTemplate | undefined;

// Migrating a fresh file costs one fsync per statement (see MigratedDatabaseTemplate), which
// timed this hook out on a Windows runner. Migrate once and give each test a copy.
beforeAll(async () => {
  migrated = await MigratedDatabaseTemplate.create('durable-revocations');
}, 120_000);

afterAll(() => {
  migrated?.dispose();
});

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'durable-revocations-'));
  if (!migrated) throw new Error('expected the migrated template from beforeAll | received: none');
  migrated.copyInto(directory);
  file = new ObservedFileDatabase(directory);
  // `runMigrations` lowers the level on its own connection; this connection starts at FULL.
  await relaxDurability(file.db);
  // These tests look at pragma levels, not at relations: no users or environments are seeded.
  file.sqlite.exec('PRAGMA foreign_keys = OFF');
  file.sqlite.exec('CREATE TABLE credential_scratch (id TEXT PRIMARY KEY)');
  file.sqlite.exec("INSERT INTO credential_scratch VALUES ('revoked-credential')");
  file.forget();
});

afterEach(async () => {
  await file.destroy();
  removeFixtureDirSync({ role: 'durable-revocations', path: directory });
});

const deleteScratchCredential = () => sql`DELETE FROM credential_scratch`.execute(file.db);
const scratchDeleteLevel = () => file.levelOf(/delete from credential_scratch/i);

describe('the runtime pairing token', () => {
  const input = { id: 'token-1', userId: 'user-1', environmentId: 'env-1', tokenHash: 'hash-1' };

  it('is replaced at FULL, the delete of the old one and the insert of the new', async () => {
    const repository = createRuntimePairingRepository(file.db);

    await repository.replace(input);

    expect({
      removedOld: file.levelOf(/delete from "runtime_pairing_tokens"/i),
      insertedNew: file.levelOf(/insert into "runtime_pairing_tokens"/i),
      afterwards: file.level(),
    }).toEqual({ removedOld: FULL, insertedNew: FULL, afterwards: NORMAL });
  });

  it('is revoked at FULL, and a later touch is written at NORMAL again', async () => {
    const repository = createRuntimePairingRepository(file.db);
    await repository.replace(input);
    file.forget();

    const revoked = await repository.revokeForEnvironment('user-1', 'env-1');
    await repository.touch('token-1', 5);

    expect({
      revoked,
      revokeLevel: file.levelOf(/set "revokedAt"/i),
      touchLevel: file.levelOf(/set "lastSeenAt"/i),
    }).toEqual({ revoked: 1, revokeLevel: FULL, touchLevel: NORMAL });
  });
});

/** Named fake for the API key plugin: deleting a key writes through the shared connection, as Better Auth does. */
class FakeApiKeyApi implements ApiKeyPluginApi {
  constructor(private readonly ownerId: string) {}

  createApiKey(): Promise<ApiKeyPluginRecord & { key: string }> {
    return Promise.reject(new Error('expected revokeApiKey to call only list and delete'));
  }

  listApiKeys(): Promise<{ apiKeys: ApiKeyPluginRecord[]; total: number }> {
    const key: ApiKeyPluginRecord = {
      id: 'key-1',
      name: 'ci',
      start: 'mgs_',
      referenceId: this.ownerId,
      createdAt: new Date(0),
      expiresAt: null,
      lastRequest: null,
      metadata: { scope: 'full' },
    };
    return Promise.resolve({ apiKeys: [key], total: 1 });
  }

  async deleteApiKey(): Promise<{ success: boolean }> {
    await deleteScratchCredential();
    return { success: true };
  }

  verifyApiKey(): Promise<never> {
    return Promise.reject(new Error('expected revokeApiKey to call only list and delete'));
  }
}

describe('an API key', () => {
  it('is deleted at FULL, and the level goes back to NORMAL after', async () => {
    const api = new FakeApiKeyApi('user-1');

    await revokeApiKey({ userId: 'user-1', headers: new Headers() }, 'key-1', api, file.db);

    expect({ deleteLevel: scratchDeleteLevel(), afterwards: file.level() }).toEqual({
      deleteLevel: FULL,
      afterwards: NORMAL,
    });
  });
});

describe('a request handled by Better Auth', () => {
  it('commits what it deletes (a session, other sessions on a password change) at FULL', async () => {
    const handler = async (_request: Request): Promise<Response> => {
      await deleteScratchCredential();
      return new Response('{}');
    };

    const response = await handleAuthRequest(
      new Request('http://localhost/api/auth/sign-out', { method: 'POST', body: '{}' }),
      { db: file.db, handler }
    );

    expect({
      status: response.status,
      deleteLevel: scratchDeleteLevel(),
      afterwards: file.level(),
    }).toEqual({ status: 200, deleteLevel: FULL, afterwards: NORMAL });
  });
});

describe('a database that is not relaxed', () => {
  it('lets a revocation commit as it always did, without touching the pragma', async () => {
    const plainDirectory = mkdtempSync(join(tmpdir(), 'durable-revocations-plain-'));
    const plain = new ObservedFileDatabase(plainDirectory);
    try {
      await handleAuthRequest(
        new Request('http://localhost/api/auth/sign-out', { method: 'POST', body: '{}' }),
        { db: plain.db, handler: () => Promise.resolve(new Response('{}')) }
      );

      expect(plain.observed.some((entry) => /PRAGMA synchronous\s*=/i.test(entry.sql))).toBe(false);
    } finally {
      await plain.destroy();
      removeFixtureDirSync({ role: 'durable-revocations', path: plainDirectory });
    }
  });
});
