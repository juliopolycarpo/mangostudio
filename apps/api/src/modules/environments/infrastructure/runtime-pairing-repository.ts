import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type {
  Database,
  RuntimePairingTokenInsert,
  RuntimePairingTokenSelect,
  RuntimePairingTokenUpdate,
} from '../../../db/types';

interface RuntimePairingTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly environmentId: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly revokedAt: number | null;
}

export interface RuntimePairingRepository {
  /** The live token for an environment, or null once it was revoked. */
  findActiveForEnvironment(
    userId: string,
    environmentId: string
  ): Promise<RuntimePairingTokenRecord | null>;
  /** Looks a token up by its public selector half, revoked rows included. */
  findById(id: string): Promise<RuntimePairingTokenRecord | null>;
  /** Replaces whatever the environment had; returns the stored row. */
  replace(input: {
    readonly id: string;
    readonly userId: string;
    readonly environmentId: string;
    readonly tokenHash: string;
  }): Promise<RuntimePairingTokenRecord>;
  /** Marks every live token for an environment revoked. Returns how many. */
  revokeForEnvironment(userId: string, environmentId: string): Promise<number>;
  touch(id: string, seenAt: number): Promise<void>;
}

function toRecord(row: RuntimePairingTokenSelect): RuntimePairingTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    environmentId: row.environmentId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

export function createRuntimePairingRepository(
  db: Kysely<Database> = getDb()
): RuntimePairingRepository {
  return {
    async findActiveForEnvironment(userId, environmentId) {
      const row = await db
        .selectFrom('runtime_pairing_tokens')
        .selectAll()
        .where('userId', '=', userId)
        .where('environmentId', '=', environmentId)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      return row ? toRecord(row) : null;
    },

    async findById(id) {
      const row = await db
        .selectFrom('runtime_pairing_tokens')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toRecord(row) : null;
    },

    async replace(input) {
      const createdAt = Date.now();
      const row: RuntimePairingTokenInsert = {
        id: input.id,
        userId: input.userId,
        environmentId: input.environmentId,
        tokenHash: input.tokenHash,
        createdAt,
        lastSeenAt: null,
        revokedAt: null,
      };
      // Rotation is one transaction on purpose: a crash between the delete and
      // the insert would otherwise leave an environment that shows no token
      // while the operator is holding the string the UI just printed.
      await db.transaction().execute(async (transaction) => {
        await transaction
          .deleteFrom('runtime_pairing_tokens')
          .where('userId', '=', input.userId)
          .where('environmentId', '=', input.environmentId)
          .execute();
        await transaction.insertInto('runtime_pairing_tokens').values(row).execute();
      });
      return {
        id: input.id,
        userId: input.userId,
        environmentId: input.environmentId,
        tokenHash: input.tokenHash,
        createdAt,
        lastSeenAt: null,
        revokedAt: null,
      };
    },

    async revokeForEnvironment(userId, environmentId) {
      const update: RuntimePairingTokenUpdate = { revokedAt: Date.now() };
      const result = await db
        .updateTable('runtime_pairing_tokens')
        .set(update)
        .where('userId', '=', userId)
        .where('environmentId', '=', environmentId)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async touch(id, seenAt) {
      const update: RuntimePairingTokenUpdate = { lastSeenAt: seenAt };
      await db
        .updateTable('runtime_pairing_tokens')
        .set(update)
        .where('id', '=', id)
        .executeTakeFirst();
    },
  };
}

export const runtimePairingRepository = createRuntimePairingRepository();
