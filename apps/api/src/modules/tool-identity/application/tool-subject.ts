/**
 * Who a subject key is allowed to name.
 *
 * Shared by the name/monogram writes and the image writes so both answer the
 * same way: an identity is a label hung on an id the product already knows,
 * and an `mcp:` label may only hang on one of the caller's own servers.
 */

import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import { type ParsedSubjectKey, parseSubjectKey } from '@mangostudio/shared/tool-identity';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';

export class ToolIdentityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode
  ) {
    super(message);
    this.name = 'ToolIdentityError';
  }
}

/**
 * Splits a subject key and rejects one whose kind or id the contract does not
 * know. Everything a write needs except MCP ownership, which only matters when
 * a row is about to be stored.
 */
export function parseKnownSubject(subjectKey: string): ParsedSubjectKey {
  const subject = parseSubjectKey(subjectKey);
  if (!subject) {
    throw new ToolIdentityError(
      `Unknown tool subject "${subjectKey}".`,
      422,
      ERROR_CODES.VALIDATION
    );
  }
  return subject;
}

/**
 * An `mcp:` label may only be stored against one of the caller's own servers,
 * so a key cannot be used to probe another user's setup. Checked before a write
 * rather than on every operation — a reset must still work once the server is
 * gone, or an orphaned row would be permanently unresettable.
 */
export async function assertOwnedMcpSubject(
  db: Kysely<Database>,
  userId: string,
  subject: ParsedSubjectKey
): Promise<void> {
  if (subject.kind !== 'mcp') return;

  const server = await db
    .selectFrom('mcp_servers')
    .select('id')
    .where('userId', '=', userId)
    .where('slug', '=', subject.id)
    .executeTakeFirst();

  if (!server) {
    throw new ToolIdentityError(`Unknown MCP server "${subject.id}".`, 422, ERROR_CODES.VALIDATION);
  }
}
