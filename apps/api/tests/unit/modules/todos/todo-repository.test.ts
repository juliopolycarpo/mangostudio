import { describe, expect, it } from 'bun:test';
import type { TodoItem } from '@mangostudio/shared/todos';
import { getDb } from '../../../../src/db/database';
import {
  getChatTodos,
  replaceChatTodos,
} from '../../../../src/modules/todos/infrastructure/todo-repository';

async function seedChat(chatId: string, userId: string) {
  const db = getDb();
  await db
    .insertInto('user')
    .values({
      id: userId,
      name: 'Todo Owner',
      email: `${userId}@mangostudio.test`,
      emailVerified: 0,
      image: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('chats')
    .values({
      id: chatId,
      title: `Chat ${chatId}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

function todo(content: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { content, status };
}

describe('todo repository', () => {
  it('returns an empty list for a chat without todos', async () => {
    const suffix = Date.now().toString();
    await seedChat(`todos-empty-${suffix}`, `todos-user-${suffix}`);

    expect(await getChatTodos(getDb(), `todos-user-${suffix}`, `todos-empty-${suffix}`)).toEqual(
      []
    );
  });

  it('roundtrips a written list and replaces it wholesale on the next write', async () => {
    const suffix = `${Date.now()}-rt`;
    const userId = `todos-user-${suffix}`;
    const chatId = `todos-chat-${suffix}`;
    await seedChat(chatId, userId);
    const db = getDb();

    await replaceChatTodos(db, userId, chatId, [todo('a', 'in_progress'), todo('b')]);
    expect(await getChatTodos(db, userId, chatId)).toEqual([todo('a', 'in_progress'), todo('b')]);

    await replaceChatTodos(db, userId, chatId, [todo('a', 'completed')]);
    expect(await getChatTodos(db, userId, chatId)).toEqual([todo('a', 'completed')]);
  });

  it('does not leak todos across users', async () => {
    const suffix = `${Date.now()}-leak`;
    const userId = `todos-user-${suffix}`;
    const chatId = `todos-chat-${suffix}`;
    await seedChat(chatId, userId);
    const db = getDb();

    await replaceChatTodos(db, userId, chatId, [todo('secret plan')]);
    expect(await getChatTodos(db, 'someone-else', chatId)).toEqual([]);
  });

  it('self-heals a corrupt row to an empty list', async () => {
    const suffix = `${Date.now()}-corrupt`;
    const userId = `todos-user-${suffix}`;
    const chatId = `todos-chat-${suffix}`;
    await seedChat(chatId, userId);
    const db = getDb();

    await db
      .insertInto('chat_todos')
      .values({ chatId, userId, items: 'not json {', updatedAt: Date.now() })
      .execute();
    expect(await getChatTodos(db, userId, chatId)).toEqual([]);

    await replaceChatTodos(db, userId, chatId, [todo('recovered')]);
    expect(await getChatTodos(db, userId, chatId)).toEqual([todo('recovered')]);
  });

  it('treats a schema-invalid payload as empty', async () => {
    const suffix = `${Date.now()}-invalid`;
    const userId = `todos-user-${suffix}`;
    const chatId = `todos-chat-${suffix}`;
    await seedChat(chatId, userId);
    const db = getDb();

    await db
      .insertInto('chat_todos')
      .values({
        chatId,
        userId,
        items: JSON.stringify([{ content: 'x', status: 'done' }]),
        updatedAt: Date.now(),
      })
      .execute();
    expect(await getChatTodos(db, userId, chatId)).toEqual([]);
  });
});
