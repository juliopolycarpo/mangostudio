import type {
  InstallRecipeId,
  InstallRun,
  InstallRunStatus,
} from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type {
  Database,
  EnvironmentInstallRunInsert,
  EnvironmentInstallRunSelect,
} from '../../../db/types';

const DEFAULT_RUN_LIMIT = 100;

interface CreateInstallRun {
  readonly id: string;
  readonly userId: string;
  readonly recipeId: InstallRecipeId;
  readonly argv: readonly string[];
  readonly startedAt: number;
}

interface CompleteInstallRun {
  readonly finishedAt: number;
  readonly exitCode: number | null;
  readonly status: Exclude<InstallRunStatus, 'running'>;
  readonly truncated: boolean;
}

export interface InstallRunRepository {
  create(input: CreateInstallRun): Promise<InstallRun>;
  complete(id: string, userId: string, result: CompleteInstallRun): Promise<void>;
  find(id: string, userId: string): Promise<InstallRun | null>;
  list(userId: string, limit?: number): Promise<InstallRun[]>;
}

function parseArgv(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Install run contains invalid argv data.');
  }
  return parsed;
}

function toInstallRun(row: EnvironmentInstallRunSelect): InstallRun {
  return {
    id: row.id,
    recipeId: row.recipeId as InstallRecipeId,
    argv: parseArgv(row.argvJson),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    status: row.status as InstallRunStatus,
    truncated: row.truncated === 1,
  };
}

export function createInstallRunRepository(db: Kysely<Database> = getDb()): InstallRunRepository {
  return {
    async create(input) {
      const row: EnvironmentInstallRunInsert = {
        id: input.id,
        userId: input.userId,
        recipeId: input.recipeId,
        argvJson: JSON.stringify(input.argv),
        startedAt: input.startedAt,
        finishedAt: null,
        exitCode: null,
        status: 'running',
        truncated: 0,
      };
      await db.insertInto('environment_install_runs').values(row).execute();
      return {
        id: input.id,
        recipeId: input.recipeId,
        argv: [...input.argv],
        startedAt: input.startedAt,
        finishedAt: null,
        exitCode: null,
        status: 'running',
        truncated: false,
      };
    },

    async complete(id, userId, result) {
      await db
        .updateTable('environment_install_runs')
        .set({
          finishedAt: result.finishedAt,
          exitCode: result.exitCode,
          status: result.status,
          truncated: result.truncated ? 1 : 0,
        })
        .where('id', '=', id)
        .where('userId', '=', userId)
        .execute();
    },

    async find(id, userId) {
      const row = await db
        .selectFrom('environment_install_runs')
        .selectAll()
        .where('id', '=', id)
        .where('userId', '=', userId)
        .executeTakeFirst();
      return row ? toInstallRun(row) : null;
    },

    async list(userId, limit = DEFAULT_RUN_LIMIT) {
      const safeLimit = Math.max(1, Math.min(DEFAULT_RUN_LIMIT, Math.trunc(limit)));
      const rows = await db
        .selectFrom('environment_install_runs')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('startedAt', 'desc')
        .limit(safeLimit)
        .execute();
      return rows.map(toInstallRun);
    },
  };
}
