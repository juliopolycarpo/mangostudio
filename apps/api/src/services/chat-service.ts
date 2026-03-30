import type { Kysely } from 'kysely';
import type { Database } from '../db/types';

/**
 * Verifies that a chat exists and belongs to the given user.
 * Returns `true` when ownership is confirmed, `false` otherwise.
 */
export async function verifyChatOwnership(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<boolean> {
  const chat = await db
    .selectFrom('chats')
    .select('userId')
    .where('id', '=', chatId)
    .executeTakeFirst();

  return chat?.userId === userId;
}
