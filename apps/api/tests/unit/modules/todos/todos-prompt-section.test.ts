import { describe, expect, it } from 'bun:test';
import { TODO_WRITE_TOOL_NAME } from '@mangostudio/shared/todos';
import { getDb } from '../../../../src/db/database';
import { appendTodosPromptSection } from '../../../../src/modules/todos/application/todos-prompt-section';
import { replaceChatTodos } from '../../../../src/modules/todos/infrastructure/todo-repository';

const ALLOWED = new Set([TODO_WRITE_TOOL_NAME]);

async function seedChat(chatId: string, userId: string) {
  const db = getDb();
  await db
    .insertInto('user')
    .values({
      id: userId,
      name: 'Prompt Owner',
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

describe('appendTodosPromptSection', () => {
  it('returns the prompt unchanged for an empty list', async () => {
    const suffix = `${Date.now()}-empty`;
    await seedChat(`tps-chat-${suffix}`, `tps-user-${suffix}`);

    const prompt = await appendTodosPromptSection(
      getDb(),
      `tps-user-${suffix}`,
      `tps-chat-${suffix}`,
      'base prompt',
      ALLOWED
    );

    expect(prompt).toBe('base prompt');
  });

  it('returns the prompt unchanged when the todo tools are not in the toolset', async () => {
    const suffix = `${Date.now()}-denied`;
    const userId = `tps-user-${suffix}`;
    const chatId = `tps-chat-${suffix}`;
    await seedChat(chatId, userId);
    await replaceChatTodos(getDb(), userId, chatId, [{ content: 'task', status: 'pending' }]);

    const prompt = await appendTodosPromptSection(
      getDb(),
      userId,
      chatId,
      'base prompt',
      new Set(['read_file'])
    );

    expect(prompt).toBe('base prompt');
  });

  it('appends the checklist section when the chat has todos', async () => {
    const suffix = `${Date.now()}-append`;
    const userId = `tps-user-${suffix}`;
    const chatId = `tps-chat-${suffix}`;
    await seedChat(chatId, userId);
    await replaceChatTodos(getDb(), userId, chatId, [
      { content: 'first step', status: 'in_progress' },
    ]);

    const prompt = await appendTodosPromptSection(getDb(), userId, chatId, 'base prompt', ALLOWED);

    expect(prompt?.startsWith('base prompt\n\n<current-todo-list>')).toBe(true);
    expect(prompt).toContain('- [>] first step');
  });

  it('uses the section alone when there is no base prompt', async () => {
    const suffix = `${Date.now()}-alone`;
    const userId = `tps-user-${suffix}`;
    const chatId = `tps-chat-${suffix}`;
    await seedChat(chatId, userId);
    await replaceChatTodos(getDb(), userId, chatId, [{ content: 'solo', status: 'pending' }]);

    const prompt = await appendTodosPromptSection(getDb(), userId, chatId, undefined, ALLOWED);

    expect(prompt?.startsWith('<current-todo-list>')).toBe(true);
  });
});
