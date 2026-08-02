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

export interface EnvironmentRepository {
  list(userId: string): Promise<EnvironmentRecord[]>;
  find(userId: string, id: string): Promise<EnvironmentRecord | null>;
  create(input: CreateEnvironmentRecord): Promise<EnvironmentRecord | null>;
  update(
    userId: string,
    id: string,
    input: UpdateEnvironmentRecord
  ): Promise<EnvironmentRecord | null>;
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

export function createEnvironmentRepository(db: Kysely<Database> = getDb()): EnvironmentRepository {
  return {
    async list(userId) {
      const rows = await db
        .selectFrom('environments')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('name')
        .execute();
      return rows.map(toEnvironmentRecord);
    },

    async find(userId, id) {
      const row = await db
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
      const result = await db
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
      const result = await db
        .updateTable('environments')
        .set(update)
        .where('userId', '=', userId)
        .where('id', '=', id)
        .executeTakeFirst();
      return result.numUpdatedRows === 0n ? null : await this.find(userId, id);
    },

    async remove(userId, id) {
      return await db.transaction().execute(async (transaction) => {
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
