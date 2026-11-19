import { describe, expect, it } from 'bun:test';

import { getDb } from '../../../../../src/db/database';
import { getChatUseCase } from '../../../../../src/modules/chats/application/get-chat';
import { listChatsUseCase } from '../../../../../src/modules/chats/application/list-chats';
import { ChatNotFoundError } from '../../../../../src/modules/chats/domain/chat-ownership';
import { insertTestChat, insertTestUser } from '../../../../support/factories';

const SNAPSHOT = {
  estimatedInputTokens: 120_000,
  contextLimit: 200_000,
  estimatedUsageRatio: 0.6,
  mode: 'stateful',
  severity: 'warning',
  lastUpdatedAt: 1_750_000_000_000,
};

describe('getChatUseCase', () => {
  it('returns the chat exactly as the list returns it, context info included', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id, { title: 'With context' });
    await getDb()
      .updateTable('chats')
      .set({ lastContextState: JSON.stringify(SNAPSHOT) })
      .where('id', '=', chat.id)
      .execute();

    const fetched = await getChatUseCase({ chatId: chat.id, userId: user.id }, getDb());
    const { items } = await listChatsUseCase({ userId: user.id }, getDb());

    expect(fetched.contextInfo).toMatchObject({ severity: 'warning', mode: 'stateful' });
    const listed = items.find((item) => item.id === chat.id);
    expect(listed, `expected ${chat.id} in the list`).toBeDefined();
    expect(fetched).toEqual(listed as NonNullable<typeof listed>);
  });

  it('refuses a missing chat and another account chat with the same error', async () => {
    const owner = await insertTestUser();
    const stranger = await insertTestUser();
    const chat = await insertTestChat(owner.id);

    await expect(getChatUseCase({ chatId: chat.id, userId: stranger.id }, getDb())).rejects.toThrow(
      ChatNotFoundError
    );
    await expect(getChatUseCase({ chatId: 'missing', userId: owner.id }, getDb())).rejects.toThrow(
      ChatNotFoundError
    );
  });
});
