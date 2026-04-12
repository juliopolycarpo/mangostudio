import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { assertMessageOwnership } from '../domain/message-ownership';
import { updateMessage, type UpdateMessageData } from '../infrastructure/message-repository';

export interface UpdateMessageInput {
  messageId: string;
  userId: string;
  updates: UpdateMessageData;
}

export async function updateMessageUseCase(
  input: UpdateMessageInput,
  db: Kysely<Database>
): Promise<void> {
  await assertMessageOwnership(input.messageId, input.userId, db);
  await updateMessage(input.messageId, input.updates, db);
}
