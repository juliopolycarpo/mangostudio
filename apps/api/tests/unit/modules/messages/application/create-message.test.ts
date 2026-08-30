import { afterEach, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../../src/db/database';
import { createMessageUseCase } from '../../../../../src/modules/messages/application/create-message';
import { generateId } from '../../../../../src/utils/id';
import { insertTestChat, insertTestUser } from '../../../../support/factories';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../../support/mocks/recording-realtime-bus';

afterEach(() => {
  restoreRealtimeBus();
});

describe('createMessageUseCase', () => {
  it('signals the activity topic after moving the chat timestamp', async () => {
    // `POST /chats/:id/messages` reorders the chat list for every open tab. The
    // route writes the row and moves `updatedAt`; without the signal the other
    // tabs keep the old ordering until an unrelated mutation happens to fire.
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const timestamp = Date.now() + 1000;

    await createMessageUseCase(
      {
        id: generateId(),
        chatId: chat.id,
        userId: user.id,
        role: 'user',
        text: 'a message written straight through the route',
        timestamp,
        interactionMode: 'chat',
      },
      getDb()
    );

    const row = await getDb()
      .selectFrom('chats')
      .select('updatedAt')
      .where('id', '=', chat.id)
      .executeTakeFirstOrThrow();

    expect(row.updatedAt).toBe(timestamp);
    expect(bus.activityFramesFor(user.id)).toHaveLength(1);
  });

  it('addresses the signal to the message author, not to every listener', async () => {
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const other = await insertTestUser();
    const chat = await insertTestChat(user.id);

    await createMessageUseCase(
      {
        id: generateId(),
        chatId: chat.id,
        userId: user.id,
        role: 'ai',
        text: 'reply',
        timestamp: Date.now(),
        interactionMode: 'chat',
      },
      getDb()
    );

    expect(bus.activityFramesFor(other.id)).toHaveLength(0);
  });
});
