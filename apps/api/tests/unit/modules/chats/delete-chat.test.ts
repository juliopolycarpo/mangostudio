import { afterEach, describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import { deleteChatUseCase } from '../../../../src/modules/chats/application/delete-chat';
import { insertTestChat, insertTestUser } from '../../../support/factories';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

afterEach(() => {
  restoreRealtimeBus();
});

async function chatExists(chatId: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom('chats')
    .select('id')
    .where('id', '=', chatId)
    .executeTakeFirst();
  return row !== undefined;
}

describe('deleteChatUseCase realtime invalidation', () => {
  it('sends one chats frame to the owner once the chat is deleted', async () => {
    // Other tabs keep listing a deleted chat until a frame tells them the list
    // is stale; neither the activity nor the chats topic carried one before.
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const other = await insertTestUser();
    const chat = await insertTestChat(user.id);

    await deleteChatUseCase({ chatId: chat.id, userId: user.id }, getDb());

    expect(await chatExists(chat.id)).toBe(false);
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);
    expect(bus.chatListFramesFor(other.id)).toHaveLength(0);
    expect(bus.activityFramesFor(user.id)).toHaveLength(0);
  });

  it('sends nothing when the caller does not own the chat, and leaves the chat alone', async () => {
    const bus = installRecordingRealtimeBus();
    const owner = await insertTestUser();
    const intruder = await insertTestUser();
    const chat = await insertTestChat(owner.id);

    await deleteChatUseCase({ chatId: chat.id, userId: intruder.id }, getDb());

    expect(await chatExists(chat.id)).toBe(true);
    expect(bus.published).toHaveLength(0);
  });
});
