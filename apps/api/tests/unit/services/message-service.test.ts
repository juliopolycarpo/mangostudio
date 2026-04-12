import { describe, expect, it, beforeAll } from 'bun:test';
import { getDb } from '../../../src/db/database';
import {
  insertMessage,
  loadHistory,
} from '../../../src/modules/messages/infrastructure/message-repository';

const USER_ID = 'user-ms-test';
const CHAT_ID = 'chat-ms-test';

beforeAll(async () => {
  const db = getDb();

  await db
    .insertInto('user')
    .values({
      id: USER_ID,
      name: 'MS Test User',
      email: 'ms-test@mangostudio.test',
      emailVerified: 0,
      image: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('chats')
    .values({
      id: CHAT_ID,
      title: 'MS Test Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: USER_ID,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  const now = Date.now();
  const messages = [
    { id: 'ms-msg-1', role: 'user' as const, text: 'Hello', timestamp: now },
    { id: 'ms-msg-2', role: 'ai' as const, text: 'World', timestamp: now + 1 },
    { id: 'ms-msg-3', role: 'user' as const, text: 'Bye', timestamp: now + 2 },
  ];

  for (const msg of messages) {
    await insertMessage(
      {
        id: msg.id,
        chatId: CHAT_ID,
        role: msg.role,
        text: msg.text,
        timestamp: msg.timestamp,
        isGenerating: false,
        interactionMode: 'chat',
      },
      db
    );
  }
});

describe('loadHistory', () => {
  it('returns all messages in chronological order including id field', async () => {
    const db = getDb();
    const history = await loadHistory(CHAT_ID, {}, db);

    expect(history.length).toBe(3);
    expect(history[0]).toMatchObject({ id: 'ms-msg-1', role: 'user', text: 'Hello' });
    expect(history[1]).toMatchObject({ id: 'ms-msg-2', role: 'ai', text: 'World' });
    expect(history[2]).toMatchObject({ id: 'ms-msg-3', role: 'user', text: 'Bye' });
  });

  it('excludes the specified message when excludeId is provided', async () => {
    const db = getDb();
    const history = await loadHistory(CHAT_ID, { excludeId: 'ms-msg-1' }, db);

    expect(history.length).toBe(2);
    expect(history.find((m) => m.id === 'ms-msg-1')).toBeUndefined();
    expect(history[0]).toMatchObject({ id: 'ms-msg-2', role: 'ai', text: 'World' });
  });

  it('each turn includes the id field', async () => {
    const db = getDb();
    const history = await loadHistory(CHAT_ID, {}, db);

    for (const turn of history) {
      expect(typeof turn.id).toBe('string');
      expect(turn.id.length).toBeGreaterThan(0);
    }
  });
});
