/**
 * The chat list's signal is owned by the code that moves `chats.updatedAt`.
 *
 * Each path that writes the column is pinned here to exactly one `chats` frame
 * for the acting user: `updateChatAfterTurn` (five turn finalizers and
 * compaction), `persistImageTurn`, and `createMessageUseCase` through the
 * helper. `chat-list-signal-boundary.test.ts` pins the other half: that nothing
 * else writes the column or publishes the frame.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { Kysely } from 'kysely';

import { getDb } from '../../../../src/db/database';
import type { Database } from '../../../../src/db/types';
import {
  persistImageTurn,
  updateChatAfterTurn,
} from '../../../../src/modules/generation/infrastructure/conversation-persistence';
import { createMessageUseCase } from '../../../../src/modules/messages/application/create-message';
import { generateId } from '../../../../src/utils/id';
import { insertTestChat, insertTestUser } from '../../../support/factories';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

afterEach(() => {
  restoreRealtimeBus();
});

/** A database whose every write fails, standing in for a full disk. */
class RejectingChatWriteDb {
  updateTable(): never {
    throw new Error('disk full');
  }
}

function rejectingChatWriteDb(): Kysely<Database> {
  return new RejectingChatWriteDb() as unknown as Kysely<Database>;
}

async function readUpdatedAt(chatId: string): Promise<number> {
  const row = await getDb()
    .selectFrom('chats')
    .select('updatedAt')
    .where('id', '=', chatId)
    .executeTakeFirstOrThrow();
  return row.updatedAt;
}

function imageTurnInput(userId: string, chatId: string, aiTimestamp: number) {
  return {
    userId,
    userMsgId: generateId(),
    aiMsgId: generateId(),
    chatId,
    prompt: 'A calm lake at sunrise.',
    generatedImages: [
      {
        id: generateId(),
        imageUrl: '/uploads/lake.png',
        generationTime: '1.0s',
        modelName: 'image-model',
        createdAt: aiTimestamp,
      },
    ],
    userTimestamp: aiTimestamp - 1,
    aiTimestamp,
  };
}

describe('updateChatAfterTurn', () => {
  it('moves the timestamp and sends one chats frame to the acting user only', async () => {
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const other = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const timestamp = Date.now() + 5_000;

    await updateChatAfterTurn(chat.id, user.id, timestamp, getDb());

    expect(await readUpdatedAt(chat.id)).toBe(timestamp);
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);
    expect(bus.chatListFramesFor(other.id)).toHaveLength(0);
    expect(bus.activityFramesFor(user.id)).toHaveLength(0);
  });

  it('still announces when the chat was deleted mid-turn', async () => {
    // The guarded write matches no row, but every other tab is still showing a
    // chat that is gone.
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();

    await updateChatAfterTurn('deleted-chat', user.id, Date.now(), getDb());

    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);
  });

  it('announces nothing when a best-effort write fails, and when a plain one throws', async () => {
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();

    await updateChatAfterTurn('chat-1', user.id, 1, rejectingChatWriteDb(), { bestEffort: true });
    await expect(updateChatAfterTurn('chat-1', user.id, 1, rejectingChatWriteDb())).rejects.toThrow(
      'disk full'
    );

    expect(bus.chatListFramesFor(user.id)).toHaveLength(0);
  });
});

describe('persistImageTurn', () => {
  it('sends one chats frame once the transaction has committed', async () => {
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const aiTimestamp = Date.now() + 5_000;

    await persistImageTurn(imageTurnInput(user.id, chat.id, aiTimestamp), getDb());

    expect(await readUpdatedAt(chat.id)).toBe(aiTimestamp);
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);
  });

  it('sends no frame when the transaction rolls back', async () => {
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const before = await readUpdatedAt(chat.id);
    const aiTimestamp = Date.now() + 5_000;
    // A user message id that already exists makes the first insert fail.
    const existingMessageId = generateId();
    await createMessageUseCase(
      {
        id: existingMessageId,
        chatId: chat.id,
        userId: user.id,
        role: 'user',
        text: 'already here',
        timestamp: before,
        interactionMode: 'chat',
      },
      getDb()
    );
    bus.published.length = 0;

    await expect(
      persistImageTurn(
        { ...imageTurnInput(user.id, chat.id, aiTimestamp), userMsgId: existingMessageId },
        getDb()
      )
    ).rejects.toThrow();

    expect(await readUpdatedAt(chat.id)).toBe(before);
    expect(bus.chatListFramesFor(user.id)).toHaveLength(0);
  });
});

describe('createMessageUseCase', () => {
  it('sends exactly one chats frame through the shared helper', async () => {
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const timestamp = Date.now() + 5_000;

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

    expect(await readUpdatedAt(chat.id)).toBe(timestamp);
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);
  });

  it('does not move a chat back down the list for an older message timestamp', async () => {
    // The helper's guard: a late writer holding an older timestamp keeps the
    // newer position. The route used to overwrite it unconditionally.
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const before = await readUpdatedAt(chat.id);

    await createMessageUseCase(
      {
        id: generateId(),
        chatId: chat.id,
        userId: user.id,
        role: 'user',
        text: 'a backdated message',
        timestamp: before - 10_000,
        interactionMode: 'chat',
      },
      getDb()
    );

    expect(await readUpdatedAt(chat.id)).toBe(before);
  });
});
