import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { Kysely } from 'kysely';
import type {
  Database,
  McpServerInsert,
  McpServerSelect,
  McpServerUpdate,
} from '../../../db/types';
import { McpServerError } from '../domain/mcp-server';

export function listMcpServerRows(
  db: Kysely<Database>,
  userId: string
): Promise<McpServerSelect[]> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('createdAt', 'asc')
    .execute();
}

export function getMcpServerRow(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<McpServerSelect | undefined> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('userId', '=', userId)
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function insertMcpServerRow(
  db: Kysely<Database>,
  row: McpServerInsert
): Promise<void> {
  try {
    await db.insertInto('mcp_servers').values(row).execute();
  } catch (error) {
    throw translateSlugConflict(error, row.slug);
  }
}

export async function updateMcpServerRow(
  db: Kysely<Database>,
  userId: string,
  id: string,
  patch: McpServerUpdate
): Promise<void> {
  try {
    await db
      .updateTable('mcp_servers')
      .set(patch)
      .where('userId', '=', userId)
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateSlugConflict(error, typeof patch.slug === 'string' ? patch.slug : '');
  }
}

export async function deleteMcpServerRow(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<boolean> {
  const result = await db
    .deleteFrom('mcp_servers')
    .where('userId', '=', userId)
    .where('id', '=', id)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** Maps the unique (userId, slug) index violation onto a 409 the routes expose. */
function translateSlugConflict(error: unknown, slug: string): unknown {
  const message = error instanceof Error ? error.message : '';
  if (!message.includes('UNIQUE constraint failed')) return error;
  return new McpServerError(
    `An MCP server with slug "${slug}" already exists.`,
    409,
    ERROR_CODES.CONFLICT
  );
}
