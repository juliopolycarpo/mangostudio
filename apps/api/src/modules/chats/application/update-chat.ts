import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { requireValidWorkdir } from '../../workspaces/application/workdir-validation';
import { type UpdateChatData, updateChat } from '../infrastructure/chat-repository';

export interface UpdateChatInput {
  chatId: string;
  userId: string;
  updates: UpdateChatData;
}

export async function updateChatUseCase(
  input: UpdateChatInput,
  db: Kysely<Database>
): Promise<void> {
  const updates = { ...input.updates };
  if (updates.workdir !== undefined && updates.workdir !== null) {
    updates.workdir = await requireValidWorkdir(updates.workdir);
  }
  await updateChat(input.chatId, input.userId, updates, db);
}
