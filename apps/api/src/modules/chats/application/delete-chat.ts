import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  listChatCheckpointBlobKeys,
  releaseCheckpointBlobs,
} from '../../file-checkpoints/infrastructure/checkpoint-repository';
import { deleteChat } from '../infrastructure/chat-repository';

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
  await deleteChat(input.chatId, input.userId, db);
  await releaseCheckpointBlobs(db, blobKeys);
}
