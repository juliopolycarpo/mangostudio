import type { Chat } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { recordActivity } from '../../activity/application/record-activity';
import { claimOperation } from '../../operations/application/product-operation';
import { ChatNotFoundError } from '../domain/chat-ownership';
import {
  createChat,
  type CreateChatData,
  getById,
  getOwnedChat,
} from '../infrastructure/chat-repository';
import { toPublicChat } from './public-chat';

export interface CreateChatInput {
  operationId?: string;
  title: string;
  model?: string | null;
  userId: string;
}

export async function createChatUseCase(
  input: CreateChatInput,
  db: Kysely<Database>
): Promise<Chat> {
  const operationId = input.operationId;
  if (operationId) {
    let created = false;
    const chat = await db.transaction().execute(async (tx) => {
      const { row, claimed } = await claimOperation(tx, input.userId, operationId, 'create-chat', {
        title: input.title,
        model: input.model,
      });
      if (!claimed) {
        // Portable backups keep the completed receipt but remove its result snapshot.
        const resultRedacted = row.result === null && row.state === 'completed';
        if (
          !row.chatId ||
          (!row.result && !resultRedacted) ||
          !(await getOwnedChat(row.chatId, input.userId, tx))
        ) {
          throw new ChatNotFoundError(row.chatId ?? '');
        }
        if (row.result) return JSON.parse(row.result) as Chat;
        const chat = await getById(row.chatId, tx);
        if (!chat) throw new ChatNotFoundError(row.chatId);
        return toPublicChat(chat);
      }
      const chat = toPublicChat(
        await createChat({ title: input.title, model: input.model, userId: input.userId }, tx)
      );
      await tx
        .updateTable('product_operations')
        .set({ state: 'completed', chatId: chat.id, result: JSON.stringify(chat) })
        .where('userId', '=', input.userId)
        .where('operationId', '=', operationId)
        .execute();
      created = true;
      return chat;
    });
    if (created)
      void recordActivity(
        {
          userId: input.userId,
          kind: 'chat_created',
          chatId: chat.id,
          environmentId: chat.environmentId,
          payload: { title: chat.title },
        },
        { db }
      );
    return chat;
  }
  const data: CreateChatData = {
    title: input.title,
    model: input.model,
    userId: input.userId,
  };
  const chat = await createChat(data, db);

  void recordActivity(
    {
      userId: input.userId,
      kind: 'chat_created',
      chatId: chat.id,
      environmentId: chat.environmentId,
      // A chat has no workdir at creation; one is chosen later, and the turns
      // that run in it carry it.
      payload: { title: chat.title },
    },
    { db }
  );

  return toPublicChat(chat);
}
