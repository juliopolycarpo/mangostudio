import type {
  EnvironmentTransportConfig,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type {
  Database,
  EnvironmentInsert,
  EnvironmentSelect,
  EnvironmentUpdate,
} from '../../../db/types';

export interface EnvironmentRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly transportKind: EnvironmentTransportKind;
  readonly config: unknown;
  readonly enabled: boolean;
  /** Whether install recipes may run on this machine. */
  readonly allowInstalls: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateEnvironmentRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly transportKind: Exclude<EnvironmentTransportKind, 'in-process'>;
  readonly config: EnvironmentTransportConfig['config'];
  readonly enabled: boolean;
}

export interface UpdateEnvironmentRecord {
  readonly name?: string;
  readonly config?: unknown;
  readonly enabled?: boolean;
  readonly allowInstalls?: boolean;
}

type RemoveEnvironmentResult = 'removed' | 'referenced' | 'missing';
/** Preflight for delete: same gates as {@link EnvironmentRepository.remove} without deleting. */
type RemovableEnvironmentResult = 'ok' | 'referenced' | 'missing';

export interface EnvironmentRepository {
  list(userId: string): Promise<EnvironmentRecord[]>;
  find(userId: string, id: string): Promise<EnvironmentRecord | null>;
  create(input: CreateEnvironmentRecord): Promise<EnvironmentRecord | null>;
  update(
    userId: string,
    id: string,
    input: UpdateEnvironmentRecord
  ): Promise<EnvironmentRecord | null>;
  /** Whether the environment exists and is not referenced by chats or MCP servers. */
  removable(userId: string, id: string): Promise<RemovableEnvironmentResult>;
  remove(userId: string, id: string): Promise<RemoveEnvironmentResult>;
}

function toEnvironmentRecord(row: EnvironmentSelect): EnvironmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    transportKind: row.transportKind as EnvironmentTransportKind,
    config: parseConfigJson(row.configJson),
    enabled: row.enabled === 1,
    allowInstalls: row.allowInstalls === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseConfigJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * `injected` is resolved per call rather than defaulted at construction: the
 * module-scope singleton below is built while this module is imported, and an
 * eager `= getDb()` default opened SQLite right there — creating
 * `~/.mango/database.sqlite` for anything that merely imported the app, and
 * connecting before `runMigrations()` had run. Callers still inject a database
 * for tests exactly as before.
 */
export function createEnvironmentRepository(injected?: Kysely<Database>): EnvironmentRepository {
  const db = (): Kysely<Database> => injected ?? getDb();

  return {
    async list(userId) {
      const rows = await db()
        .selectFrom('environments')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('name')
        .execute();
      return rows.map(toEnvironmentRecord);
    },

    async find(userId, id) {
      const row = await db()
        .selectFrom('environments')
        .selectAll()
        .where('userId', '=', userId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toEnvironmentRecord(row) : null;
    },

    async create(input) {
      const now = Date.now();
      const row: EnvironmentInsert = {
        id: input.id,
        userId: input.userId,
        name: input.name,
        transportKind: input.transportKind,
        configJson: JSON.stringify(input.config),
        enabled: input.enabled ? 1 : 0,
        allowInstalls: 0,
        createdAt: now,
        updatedAt: now,
      };
      const result = await db()
        .insertInto('environments')
        .values(row)
        .onConflict((conflict) => conflict.columns(['userId', 'id']).doNothing())
        .executeTakeFirst();
      return result.numInsertedOrUpdatedRows === 0n
        ? null
        : {
            ...input,
            config: input.config,
            // A new environment is never trusted with installs on arrival;
            // saying so is a separate, deliberate act.
            allowInstalls: false,
            createdAt: now,
            updatedAt: now,
          };
    },

    async update(userId, id, input) {
      const update: EnvironmentUpdate = {
        updatedAt: Date.now(),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.config !== undefined ? { configJson: JSON.stringify(input.config) } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
        ...(input.allowInstalls !== undefined
          ? { allowInstalls: input.allowInstalls ? 1 : 0 }
          : {}),
      };
      const result = await db()
        .updateTable('environments')
        .set(update)
        .where('userId', '=', userId)
        .where('id', '=', id)
        .executeTakeFirst();
      return result.numUpdatedRows === 0n ? null : await this.find(userId, id);
    },

    async removable(userId, id) {
      const environment = await db()
        .selectFrom('environments')
        .select('id')
        .where('userId', '=', userId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!environment) return 'missing';

      const chat = await db()
        .selectFrom('chats')
        .select('id')
        .where('userId', '=', userId)
        .where('environmentId', '=', id)
        .executeTakeFirst();
      if (chat) return 'referenced';

      const mcpServer = await db()
        .selectFrom('mcp_servers')
        .select('id')
        .where('userId', '=', userId)
        .where('environmentId', '=', id)
        .executeTakeFirst();
      if (mcpServer) return 'referenced';

      return 'ok';
    },

    async remove(userId, id) {
      return await db()
        .transaction()
        .execute(async (transaction) => {
          const environment = await transaction
            .selectFrom('environments')
            .select('id')
            .where('userId', '=', userId)
            .where('id', '=', id)
            .executeTakeFirst();
          if (!environment) return 'missing';

          const chat = await transaction
            .selectFrom('chats')
            .select('id')
            .where('userId', '=', userId)
            .where('environmentId', '=', id)
            .executeTakeFirst();
          if (chat) return 'referenced';

          // An MCP server row addresses one machine: its command or its URL only
          // means something there. Deleting the environment out from under it
          // would leave a server that can never connect and cannot say why.
          const mcpServer = await transaction
            .selectFrom('mcp_servers')
            .select('id')
            .where('userId', '=', userId)
            .where('environmentId', '=', id)
            .executeTakeFirst();
          if (mcpServer) return 'referenced';

          // The library backup index is a listing cache for a machine that is
          // going away. Left behind, its rows would sit on the backups page
          // forever as an offline environment nobody can connect — the bytes are
          // still on that machine's disk, but nothing here can reach them again.
          // Chats and MCP servers block the delete instead; a cache does not get
          // to.
          await transaction
            .deleteFrom('library_backups')
            .where('userId', '=', userId)
            .where('environmentId', '=', id)
            .execute();

          // Same reasoning as the backup index: a toolchain selection means
          // nothing once the machine it named is gone, and nothing here
          // resurrects the row's meaning by leaving it behind.
          await transaction
            .deleteFrom('environment_toolchains')
            .where('userId', '=', userId)
            .where('environmentId', '=', id)
            .execute();

          await transaction
            .deleteFrom('environments')
            .where('userId', '=', userId)
            .where('id', '=', id)
            .executeTakeFirst();
          return 'removed';
        });
    },
  };
}

export const environmentRepository = createEnvironmentRepository();
