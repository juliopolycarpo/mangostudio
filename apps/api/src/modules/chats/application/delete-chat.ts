import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { publishChatListInvalidation } from '../../../services/realtime/chat-list-invalidation';
import { externalSessionManager } from '../../external-agents/application/external-session-manager';
import {
  listChatCheckpointBlobKeys,
  releaseCheckpointBlobs,
} from '../../file-checkpoints/infrastructure/checkpoint-repository';
import {
  listChatGeneratedImageFilenames,
  releaseGeneratedImageFiles,
} from '../../generated-images/application/reclaim-generated-images';
import { deleteChat, verifyChatOwnership } from '../infrastructure/chat-repository';

const logger = createDiagnosticLogger('delete-chat');

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
  const owned = await verifyChatOwnership(input.chatId, input.userId, db);
  // Same shape as the blobs: the rows cascade away, the files do not. Read
  // before the delete, and only for the owner, so a foreign request cannot
  // learn or touch anything about a chat that stays.
  const imageFilenames = owned
    ? await listChatGeneratedImageFilenames(db, input.chatId)
    : new Set<string>();
  if (owned) {
    // Not awaited: the live turn is told and the session unregistered
    // synchronously, and only the vendor's own close call is left in flight.
    // Awaiting it would hold the delete response for the runtime's full call
    // timeout whenever the machine is reachable but unresponsive.
    void externalSessionManager.reapChat(input.chatId, 'cancelled-by-user').catch(() => undefined);
  }
  await deleteChat(input.chatId, input.userId, db);
  // Every other tab still lists the chat until told otherwise. Announced as soon
  // as the delete commits, ahead of the blob collection below, which is
  // housekeeping and can fail without changing what the list shows. Skipped when
  // the caller does not own the chat: nothing was deleted, so nothing is stale.
  if (owned) publishChatListInvalidation(input.userId);
  await releaseCheckpointBlobs(db, blobKeys);
  // A failure here leaves files for the periodic sweep; it must not turn a
  // committed delete into an error response, but it is worth a log line.
  await releaseGeneratedImageFiles(db, imageFilenames).catch((error: unknown) => {
    logger.warn('release_failed', {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
