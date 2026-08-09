import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { externalSessionManager } from '../../external-agents/application/external-session-manager';
import {
  listChatCheckpointBlobKeys,
  releaseCheckpointBlobs,
} from '../../file-checkpoints/infrastructure/checkpoint-repository';
import { deleteChat, verifyChatOwnership } from '../infrastructure/chat-repository';

export interface DeleteChatInput {
  chatId: string;
  userId: string;
}

export async function deleteChatUseCase(
  input: DeleteChatInput,
  db: Kysely<Database>
): Promise<void> {
  // The manifest rows cascade away with the chat, so the keys have to be read
  // first and the blobs collected afterwards — while the rows still exist every
  // blob looks referenced and nothing would ever be freed.
  const blobKeys = await listChatCheckpointBlobKeys(db, input.chatId);
  // The continuation row cascades away with the chat; this ends the vendor
  // process, which nothing cascades. Before the delete, so the session is never
  // asked to keep running for a conversation that no longer exists — and behind
  // the ownership check, so a request naming somebody else's chat cannot kill
  // their live turn on the way to deleting nothing.
  if (await verifyChatOwnership(input.chatId, input.userId, db)) {
    await externalSessionManager.reapChat(input.chatId, 'cancelled-by-user');
  }
  await deleteChat(input.chatId, input.userId, db);
  await releaseCheckpointBlobs(db, blobKeys);
}
