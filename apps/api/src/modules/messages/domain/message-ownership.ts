import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { verifyMessageOwnership } from '../infrastructure/message-repository';

export { verifyMessageOwnership };

export async function assertMessageOwnership(
  messageId: string,
  userId: string,
  db: Kysely<Database>
): Promise<void> {
  const owns = await verifyMessageOwnership(messageId, userId, db);
  if (!owns) {
    throw new MessageNotFoundError(messageId);
  }
}

export class MessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Message not found: ${messageId}`);
    this.name = 'MessageNotFoundError';
  }
}
