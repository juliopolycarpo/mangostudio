import { beforeEach, describe, expect, it } from 'bun:test';
import type { TodoItem } from '@mangostudio/shared/todos';
import { getDb } from '../../../../src/db/database';
import { getChatTodos } from '../../../../src/modules/todos/infrastructure/todo-repository';
import { executeTool, getTool } from '../../../../src/services/tools';
import {
  register,
  TODO_READ_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  type TodoToolResult,
} from '../../../../src/services/tools/builtin/todo';
import type { ToolContext } from '../../../../src/services/tools/types';

const USER_ID = 'user-todo-tool-test';

async function seedChat(chatId: string) {
  const db = getDb();
  await db
    .insertInto('user')
    .values({
      id: USER_ID,
      name: 'Todo Tool Owner',
      email: `${USER_ID}@mangostudio.test`,
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
      id: chatId,
      title: `Chat ${chatId}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: USER_ID,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

function makeContext(chatId: string): ToolContext {
  return { userId: USER_ID, chatId, parameters: {} };
}

function todo(content: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { content, status };
}

beforeEach(() => {
  register();
});

describe('todo tools registration', () => {
  it('registers both tools as disableable interaction tools', () => {
    for (const name of [TODO_WRITE_TOOL_NAME, TODO_READ_TOOL_NAME]) {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(tool?.settings.category).toBe('interaction');
      expect(tool?.settings.enabledByDefault).toBe(true);
      expect(tool?.settings.canDisable).toBe(true);
    }
    expect(getTool(TODO_WRITE_TOOL_NAME)?.definition.parameters.required).toEqual(['todos']);
  });
});

describe('todo_write', () => {
  it('persists the list and returns todos, summary, and active task', async () => {
    const chatId = `todo-write-${Date.now()}`;
    await seedChat(chatId);

    const result = (await executeTool(
      TODO_WRITE_TOOL_NAME,
      { todos: [todo('plan', 'completed'), todo('build', 'in_progress'), todo('ship')] },
      makeContext(chatId)
    )) as TodoToolResult;

    expect(result.todos).toHaveLength(3);
    expect(result.summary).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 1 });
    expect(result.activeTask).toBe('build');
    expect(await getChatTodos(getDb(), USER_ID, chatId)).toEqual([
      todo('plan', 'completed'),
      todo('build', 'in_progress'),
      todo('ship'),
    ]);
  });

  it('rejects malformed payloads with a model-correctable error', async () => {
    const chatId = `todo-write-invalid-${Date.now()}`;
    await seedChat(chatId);

    expect(executeTool(TODO_WRITE_TOOL_NAME, {}, makeContext(chatId))).rejects.toThrow(
      /Invalid todo_write arguments/
    );
    expect(
      executeTool(TODO_WRITE_TOOL_NAME, { todos: [{ content: '' }] }, makeContext(chatId))
    ).rejects.toThrow(/Invalid todo_write arguments/);
  });

  it('rejects more than one in_progress item', async () => {
    const chatId = `todo-write-active-${Date.now()}`;
    await seedChat(chatId);

    expect(
      executeTool(
        TODO_WRITE_TOOL_NAME,
        { todos: [todo('a', 'in_progress'), todo('b', 'in_progress')] },
        makeContext(chatId)
      )
    ).rejects.toThrow(/one task in_progress/);
    expect(await getChatTodos(getDb(), USER_ID, chatId)).toEqual([]);
  });
});

describe('todo_read', () => {
  it('returns an empty result for a chat without todos', async () => {
    const chatId = `todo-read-empty-${Date.now()}`;
    await seedChat(chatId);

    const result = (await executeTool(
      TODO_READ_TOOL_NAME,
      {},
      makeContext(chatId)
    )) as TodoToolResult;

    expect(result.todos).toEqual([]);
    expect(result.summary).toEqual({ total: 0, completed: 0, inProgress: 0, pending: 0 });
    expect(result.activeTask).toBeUndefined();
  });

  it('returns the list a previous todo_write persisted', async () => {
    const chatId = `todo-read-${Date.now()}`;
    await seedChat(chatId);
    await executeTool(
      TODO_WRITE_TOOL_NAME,
      { todos: [todo('resume work', 'in_progress')] },
      makeContext(chatId)
    );

    const result = (await executeTool(
      TODO_READ_TOOL_NAME,
      {},
      makeContext(chatId)
    )) as TodoToolResult;

    expect(result.todos).toEqual([todo('resume work', 'in_progress')]);
    expect(result.activeTask).toBe('resume work');
  });
});
